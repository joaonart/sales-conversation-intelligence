"""Conversation ingest process (Cloud Run). Configuration only; the rules are in sci_workers.ingest."""
from __future__ import annotations

import json
import os

import uvicorn
from fastapi import FastAPI

from sci_bq.source_writer import BigQuerySourceWriter
from sci_bq.tables import Tables
from sci_core.obs import configure_logging
from sci_workers.ingest import IngestProcessor
from sci_workers.ingest_app import create_app
from sci_workers.live_auth import GoogleOIDCVerifier
from sci_workers.pubsub import PubSubPublisher


def _env(name: str) -> str:
    try:
        return os.environ[name]
    except KeyError:
        raise SystemExit(f"missing required env var {name}") from None


def build_app() -> FastAPI:
    configure_logging()
    project, location = _env("GCP_PROJECT"), os.environ.get("BQ_LOCATION", "US")
    tables = Tables(project, os.environ.get("SOURCE_DATASET", "commerce"), os.environ.get("CONFIG_DATASET", "conversation_config"),
                    os.environ.get("ANALYTICS_DATASET", "conversation_analytics"))
    # INGEST_TENANTS: [{"organization_id": "...", "workspace_id": "..."}]. A tenant id inside a message is never authorization by itself.
    tenants = frozenset((t["organization_id"], t["workspace_id"]) for t in json.loads(_env("INGEST_TENANTS")))
    if not tenants:
        raise SystemExit("INGEST_TENANTS is empty: an ingest service that accepts nobody has no purpose")
    service_url = _env("SERVICE_URL")
    processor = IngestProcessor(tenants=tenants, writer=BigQuerySourceWriter(tables, location), publisher=PubSubPublisher(project),
                                events_topic=_env("EVENTS_TOPIC"))
    verifier = GoogleOIDCVerifier(f"{service_url}/pubsub/push", frozenset({_env("PUBSUB_PUSH_SA")}))
    return create_app(processor=processor, push_verifier=verifier, project=project)


if __name__ == "__main__":
    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), log_config=None)  # noqa: S104
