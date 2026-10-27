"""Cloud Run Job entrypoint. `preflight` never calls an AI provider; `run` is gated twice."""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import sys
from datetime import date

from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore
from sci_core.budget import PriceBook
from sci_core.loader import RubricLoader
from sci_core.obs import configure_logging
from sci_workers.historical import HistoricalJob, JobConfig


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Historical session evaluation backfill")
    p.add_argument("mode", choices=["preflight", "run"])
    p.add_argument("--project", default=os.environ.get("GCP_PROJECT"), required=not os.environ.get("GCP_PROJECT"))
    p.add_argument("--location", default=os.environ.get("BQ_LOCATION", "US"))
    p.add_argument("--source-dataset", default="commerce")
    p.add_argument("--config-dataset", default="conversation_config")
    p.add_argument("--analytics-dataset", default="conversation_analytics")
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--rubric-id", required=True)
    p.add_argument("--rubric-version", type=int, required=True)
    p.add_argument("--start", type=date.fromisoformat, required=True)
    p.add_argument("--end", type=date.fromisoformat, required=True)
    p.add_argument("--max-cost-usd", type=float, required=True)
    p.add_argument("--max-sessions", type=int, required=True)
    p.add_argument("--input-price-per-million", type=float, required=True, help="from official current pricing")
    p.add_argument("--output-price-per-million", type=float, required=True, help="from official current pricing")
    p.add_argument("--approved", action="store_true", help="operator approved the preflight report")
    return p.parse_args(argv)


async def main(argv: list[str] | None = None) -> int:
    a = parse(argv)
    configure_logging(logging.INFO)
    tables = Tables(a.project, a.source_dataset, a.config_dataset, a.analytics_dataset)
    runner = BigQueryRunner(a.project, a.location)
    writer = BigQueryResultWriter(tables, a.location)
    cfg = JobConfig(
        tenant=Tenant(a.org, a.workspace), rubric_id=a.rubric_id, rubric_version=a.rubric_version,
        start_date=a.start, end_date=a.end, prices=PriceBook(a.input_price_per_million, a.output_price_per_million),
        max_cost_usd=a.max_cost_usd, max_sessions=a.max_sessions)
    job = HistoricalJob(
        source=BigQuerySource(runner, tables), store=BigQueryRunStore(runner, writer, tables), writer=writer,
        loader=RubricLoader(BigQueryRubricRepository(runner, tables)), engine=None, config=cfg)
    if a.mode == "preflight":
        report = await job.preflight()
        print(json.dumps({**dataclasses.asdict(report), "approvable": report.approvable, "run_id": cfg.run_id}, indent=2))
        return 0 if report.approvable else 2
    if os.environ.get("AI_ENABLED") != "true" or not a.approved:
        print("refusing to run: requires AI_ENABLED=true and --approved after reviewing preflight", file=sys.stderr)
        return 3
    # Provider wiring arrives with the OpenAI adapter (phase 5) after docs/pricing validation.
    print("no AI provider adapter is configured yet", file=sys.stderr)
    return 4


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
