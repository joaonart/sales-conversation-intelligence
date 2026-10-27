"""Live worker process. AI stays disabled (engine=None) until the OpenAI adapter is validated and approved."""
from __future__ import annotations

import json
import os

import uvicorn
from fastapi import FastAPI

from sci_bq.ledger import BigQueryLedger
from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore
from sci_core.budget import PriceBook
from sci_core.loader import RubricLoader
from sci_workers.live import LiveProcessor, TenantLiveConfig
from sci_workers.live_app import create_app
from sci_workers.live_auth import GoogleOIDCVerifier
from sci_workers.scheduling import CloudTasksScheduler


def _env(name: str) -> str:
    try:
        return os.environ[name]
    except KeyError:
        raise SystemExit(f"missing required env var {name}") from None


def build_app() -> FastAPI:
    project, location = _env("GCP_PROJECT"), os.environ.get("BQ_LOCATION", "US")
    tables = Tables(project, os.environ.get("SOURCE_DATASET", "commerce"),
                    os.environ.get("CONFIG_DATASET", "conversation_config"),
                    os.environ.get("ANALYTICS_DATASET", "conversation_analytics"))
    runner = BigQueryRunner(project, location)
    writer = BigQueryResultWriter(tables, location)
    # SCI_TENANTS: [{"organization_id":..,"workspace_id":..,"rubric_id":..,"rubric_version":null,"debounce_seconds":120}]
    tenants = {
        (t["organization_id"], t["workspace_id"]): TenantLiveConfig(
            t["rubric_id"], t.get("rubric_version"), t.get("debounce_seconds", 120), t.get("min_reanalysis_seconds", 3600))
        for t in json.loads(_env("SCI_TENANTS"))
    }
    window = min((c.debounce_seconds for c in tenants.values()), default=120)
    service_url = _env("SERVICE_URL")
    processor = LiveProcessor(
        tenants=tenants, source=BigQuerySource(runner, tables), store=BigQueryRunStore(runner, writer, tables),
        ledger=BigQueryLedger(runner, tables), writer=writer, loader=RubricLoader(BigQueryRubricRepository(runner, tables)),
        engine=None,  # AI disabled by design in this phase; see docs/decisions.md
        prices=PriceBook(float(os.environ.get("INPUT_PRICE_PER_MILLION", 0)), float(os.environ.get("OUTPUT_PRICE_PER_MILLION", 0))))
    scheduler = CloudTasksScheduler(
        project=project, location=location.lower() if location != "US" else os.environ.get("REGION", "us-central1"),
        queue=_env("TASKS_QUEUE"), target_url=f"{service_url}/tasks/evaluate", invoker_sa=_env("TASKS_INVOKER_SA"),
        audience=service_url, window_seconds=window)
    return create_app(
        processor=processor, scheduler=scheduler,
        push_verifier=GoogleOIDCVerifier(f"{service_url}/pubsub/push", frozenset({_env("PUBSUB_PUSH_SA")})),
        tasks_verifier=GoogleOIDCVerifier(service_url, frozenset({_env("TASKS_INVOKER_SA")})))


if __name__ == "__main__":
    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))  # noqa: S104
