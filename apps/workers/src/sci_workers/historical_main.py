"""Cloud Run Job entrypoint. `preflight` never calls an AI provider; `run` is gated twice."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import sys
from collections.abc import Callable
from datetime import date

from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRunStore
from sci_core.budget import PriceBook
from sci_core.engine import EvaluationEngine
from sci_core.loader import RubricLoader
from sci_core.obs import configure_logging
from sci_openai.pricing import LUNA_STANDARD_SHORT
from sci_workers.ai import MissingApiKey, api_key_provider, build_engine
from sci_workers.historical import HistoricalJob, JobConfig


def _no_key() -> str:
    raise MissingApiKey("preflight never calls the provider")


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
    # The analysis identity (model + prompt version) is part of the run id and of the dedupe key, so preflight needs it too.
    # Building the engine does not call the provider; the key is only read lazily on the first request (never in preflight).
    if a.mode == "preflight":
        key: Callable[[], str] = _no_key
    else:
        if os.environ.get("AI_ENABLED") != "true" or not a.approved:
            print("refusing to run: requires AI_ENABLED=true and --approved after reviewing preflight", file=sys.stderr)
            return 3
        floor = LUNA_STANDARD_SHORT.worst_case_price_book()
        if a.input_price_per_million < floor.input_per_million or a.output_price_per_million < floor.output_per_million:
            print("refusing to run: budget prices are below the validated worst-case rates", file=sys.stderr)
            return 5
        try:
            key = api_key_provider()
        except (MissingApiKey, OSError) as exc:
            print(f"refusing to run: {type(exc).__name__}", file=sys.stderr)
            return 6
    engine = build_engine(mode="historical", tenant_safety_id=None, key=key)
    cfg = JobConfig(
        tenant=Tenant(a.org, a.workspace),
        rubric_id=a.rubric_id,
        rubric_version=a.rubric_version,
        start_date=a.start,
        end_date=a.end,
        prices=PriceBook(a.input_price_per_million, a.output_price_per_million),
        max_cost_usd=a.max_cost_usd,
        max_sessions=a.max_sessions,
        identity=engine.identity,
    )

    def make_job(engine: EvaluationEngine | None) -> HistoricalJob:
        return HistoricalJob(
            source=BigQuerySource(runner, tables),
            store=BigQueryRunStore(runner, writer, tables),
            writer=writer,
            loader=RubricLoader(BigQueryRubricRepository(runner, tables)),
            engine=engine,
            config=cfg,
        )

    if a.mode == "preflight":
        job = make_job(None)
        report = await job.preflight()
        extra = {
            "approvable": report.approvable,
            "run_id": cfg.run_id,
            "model": cfg.identity.model,
            "prompt_version": cfg.identity.prompt_version,
        }
        print(json.dumps({**dataclasses.asdict(report), **extra}, indent=2))
        return 0 if report.approvable else 2
    job = make_job(engine)
    result = await job.run(approved=True)
    print(json.dumps(dataclasses.asdict(result), indent=2, default=str))
    return 0 if result.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
