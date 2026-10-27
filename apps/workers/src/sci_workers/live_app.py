"""Cloud Run service for live analysis: Pub/Sub push -> debounce (Cloud Tasks) -> evaluate."""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import ValidationError

from sci_bq.runner import QueryTooExpensive
from sci_core.budget import BudgetExceeded
from sci_core.obs import parse_trace_header, trace_id
from sci_core.rubric import RubricError
from sci_workers.live import AIDisabled, LiveProcessor, NotReady, SessionUpdateEvent, UnauthorizedTenant
from sci_workers.live_auth import AuthError, TokenVerifier
from sci_workers.scheduling import Scheduler

log = logging.getLogger("sci.live.http")


def create_app(*, processor: LiveProcessor, scheduler: Scheduler, push_verifier: TokenVerifier,
               tasks_verifier: TokenVerifier, project: str | None = None) -> FastAPI:
    app = FastAPI(title="SCI live worker", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def correlate(request: Request, call_next):  # type: ignore[no-untyped-def]
        token = trace_id.set(parse_trace_header(request.headers.get("x-cloud-trace-context"), project))
        try:
            return await call_next(request)
        finally:
            trace_id.reset(token)

    async def authenticate(verifier: TokenVerifier, request: Request) -> None:
        try:
            await asyncio.to_thread(verifier.verify, request.headers.get("authorization"))
        except AuthError as exc:
            raise HTTPException(status_code=401, detail="unauthorized") from exc

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/pubsub/push")
    async def pubsub_push(request: Request) -> Response:
        await authenticate(push_verifier, request)
        try:
            envelope = await request.json()
            event = SessionUpdateEvent.model_validate_json(base64.b64decode(envelope["message"]["data"], validate=True))
        except (ValueError, KeyError, TypeError, binascii.Error, ValidationError) as exc:
            # Non-2xx => redelivery then DLQ: a malformed event stays inspectable, never silently dropped.
            log.warning("malformed event", extra={"event": "malformed_event", "error_type": type(exc).__name__})
            raise HTTPException(status_code=400, detail="malformed event") from exc
        if not processor.ai_enabled:
            raise HTTPException(status_code=503, detail="analysis disabled; backlog retained")
        try:
            cfg = processor.authorize(event)
        except UnauthorizedTenant as exc:
            log.warning("tenant not enabled", extra={"event": "tenant_rejected", "event_id": event.event_id})
            raise HTTPException(status_code=403, detail="tenant not enabled") from exc
        created = await scheduler.schedule(event, cfg.debounce_seconds)
        log.info("event scheduled", extra={"event": "event_scheduled", "event_id": event.event_id, "new_task": created})
        return Response(status_code=204)

    @app.post("/tasks/evaluate")
    async def evaluate(request: Request) -> dict[str, str]:
        await authenticate(tasks_verifier, request)
        try:
            event = SessionUpdateEvent.model_validate_json(await request.body())
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail="malformed task") from exc
        try:
            outcome = await processor.process(event)
        except UnauthorizedTenant as exc:
            raise HTTPException(status_code=403, detail="tenant not enabled") from exc
        except (NotReady, AIDisabled, QueryTooExpensive, BudgetExceeded) as exc:
            log.warning("task retry requested", extra={"event": "task_retry", "event_id": event.event_id, "error_type": type(exc).__name__})
            raise HTTPException(status_code=503, detail=type(exc).__name__) from exc  # Cloud Tasks retries w/ backoff
        except RubricError as exc:
            raise HTTPException(status_code=422, detail="rubric unavailable") from exc
        return {"outcome": outcome.value}

    return app
