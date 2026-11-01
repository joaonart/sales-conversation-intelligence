"""Cloud Run service that ingests conversations: Pub/Sub push -> validate -> store in BigQuery -> announce for analysis."""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import ValidationError

from sci_bq.source_writer import SourceWriteError
from sci_core.obs import parse_trace_header, trace_id
from sci_workers.ingest import ConversationEvent, IngestProcessor, InvalidConversation, UnauthorizedTenant
from sci_workers.live_auth import AuthError, TokenVerifier
from sci_workers.pubsub import PublishError

log = logging.getLogger("sci.ingest.http")


def create_app(*, processor: IngestProcessor, push_verifier: TokenVerifier, project: str | None = None) -> FastAPI:
    app = FastAPI(title="SCI conversation ingest", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def correlate(request: Request, call_next):  # type: ignore[no-untyped-def]
        token = trace_id.set(parse_trace_header(request.headers.get("x-cloud-trace-context"), project))
        try:
            return await call_next(request)
        finally:
            trace_id.reset(token)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/pubsub/push")
    async def pubsub_push(request: Request) -> Response:
        try:
            await asyncio.to_thread(push_verifier.verify, request.headers.get("authorization"))
        except AuthError as exc:
            raise HTTPException(status_code=401, detail="unauthorized") from exc
        try:
            envelope = await request.json()
            event = ConversationEvent.model_validate_json(base64.b64decode(envelope["message"]["data"], validate=True))
        except (ValueError, KeyError, TypeError, binascii.Error, ValidationError) as exc:
            # A non-2xx answer makes Pub/Sub retry and then park the message in the dead-letter hold: never silently dropped.
            log.warning("malformed conversation", extra={"event": "malformed_conversation", "error_type": type(exc).__name__})
            raise HTTPException(status_code=400, detail="malformed conversation") from exc
        try:
            result = await processor.process(event)
        except UnauthorizedTenant as exc:
            log.warning("tenant not enabled", extra={"event": "tenant_rejected", "event_id": event.event_id})
            raise HTTPException(status_code=403, detail="tenant not enabled") from exc
        except InvalidConversation as exc:
            log.warning("invalid conversation", extra={"event": "invalid_conversation", "event_id": event.event_id})
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (SourceWriteError, PublishError) as exc:
            log.warning("ingest retry requested",
                        extra={"event": "ingest_retry", "event_id": event.event_id, "error_type": type(exc).__name__})
            raise HTTPException(status_code=503, detail=type(exc).__name__) from exc
        log.info("conversation stored", extra={"event": "conversation_stored", "event_id": event.event_id, "messages": result.messages})
        return Response(status_code=204)

    return app
