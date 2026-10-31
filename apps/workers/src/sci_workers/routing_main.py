"""Cloud Run Job entrypoint for the routing pass. `preflight` never calls an AI provider; `run` is gated twice (AI_ENABLED + --approved)."""

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
from pathlib import Path

from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource, Tenant
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRouteStore
from sci_core.budget import PriceBook
from sci_core.obs import configure_logging
from sci_core.routing import RoutingConfig, RoutingError, SessionRouter
from sci_openai.pricing import LUNA_STANDARD_SHORT, TokenPrices
from sci_workers.ai import PROVIDERS, MissingApiKey, api_key_provider, build_provider
from sci_workers.routing import RoutingJob, RoutingJobConfig


def _no_key() -> str:
    raise MissingApiKey("preflight never calls the provider")


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Routing pass: choose, per session, the rubric it will be analysed with")
    p.add_argument("mode", choices=["preflight", "run"])
    p.add_argument("--project", default=os.environ.get("GCP_PROJECT"), required=not os.environ.get("GCP_PROJECT"))
    p.add_argument("--location", default=os.environ.get("BQ_LOCATION", "US"))
    p.add_argument("--source-dataset", default="commerce")
    p.add_argument("--config-dataset", default="conversation_config")
    p.add_argument("--analytics-dataset", default="conversation_analytics")
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--routes-file", type=Path, required=True,
                   help='JSON: {"routes": [{"key", "description", "rubric_id"?, "rubric_version"?}], "fallback": "<key>"}')
    p.add_argument("--start", type=date.fromisoformat, required=True)
    p.add_argument("--end", type=date.fromisoformat, required=True)
    p.add_argument("--max-cost-usd", type=float, required=True)
    p.add_argument("--max-sessions", type=int, required=True)
    p.add_argument("--input-price-per-million", type=float, required=True, help="from official current pricing")
    p.add_argument("--output-price-per-million", type=float, required=True, help="from official current pricing")
    p.add_argument("--provider", choices=PROVIDERS, default=os.environ.get("AI_PROVIDER", "decisions"))
    p.add_argument("--responses-model", default=os.environ.get("RESPONSES_MODEL"), help="required with --provider responses")
    p.add_argument("--cached-input-price-per-million", type=float, default=None, help="responses only; defaults to the input price")
    p.add_argument("--router-max-input-tokens", type=int, default=1200, help="head of the conversation sent to the classifier")
    p.add_argument("--approved", action="store_true", help="operator approved the preflight report")
    a = p.parse_args(argv)
    if a.provider == "responses" and not a.responses_model:
        p.error("--provider responses requires --responses-model (or RESPONSES_MODEL)")
    return a


def load_routes(path: Path) -> RoutingConfig:
    return RoutingConfig.parse(json.loads(path.read_text(encoding="utf-8")))


async def main(argv: list[str] | None = None) -> int:
    a = parse(argv)
    configure_logging(logging.INFO)
    try:
        routes = load_routes(a.routes_file)
    except (OSError, ValueError, RoutingError) as exc:
        print(f"invalid routes file: {exc}", file=sys.stderr)
        return 4
    tables = Tables(a.project, a.source_dataset, a.config_dataset, a.analytics_dataset)
    runner = BigQueryRunner(a.project, a.location)
    writer = BigQueryResultWriter(tables, a.location)
    key: Callable[[], str]
    if a.mode == "preflight":
        key = _no_key
    else:
        if routes_need_ai(routes) and (os.environ.get("AI_ENABLED") != "true" or not a.approved):
            print("refusing to run: requires AI_ENABLED=true and --approved after reviewing preflight", file=sys.stderr)
            return 3
        if a.provider == "decisions":
            floor = LUNA_STANDARD_SHORT.worst_case_price_book()
            if a.input_price_per_million < floor.input_per_million or a.output_price_per_million < floor.output_per_million:
                print("refusing to run: budget prices are below the validated worst-case rates", file=sys.stderr)
                return 5
        try:
            key = api_key_provider()
        except (MissingApiKey, OSError) as exc:
            print(f"refusing to run: {type(exc).__name__}", file=sys.stderr)
            return 6
    prices = LUNA_STANDARD_SHORT
    if a.provider == "responses":  # the same operator-supplied rates price the budget gate and the recorded cost; nothing is defaulted
        prices = TokenPrices(a.input_price_per_million, a.cached_input_price_per_million or a.input_price_per_million,
                             a.input_price_per_million, a.output_price_per_million, source="cli")
    ai = build_provider(tenant_safety_id=None, key=key, prices=prices, provider=a.provider, model=a.responses_model,
                        max_output_tokens=200)
    cfg = RoutingJobConfig(tenant=Tenant(a.org, a.workspace), start_date=a.start, end_date=a.end,
                           prices=PriceBook(a.input_price_per_million, a.output_price_per_million),
                           max_cost_usd=a.max_cost_usd, max_sessions=a.max_sessions)
    job = RoutingJob(source=BigQuerySource(runner, tables), store=BigQueryRouteStore(runner, writer, tables),
                     router=SessionRouter(ai, routes, max_input_tokens=a.router_max_input_tokens), config=cfg)
    if a.mode == "preflight":
        report = await job.preflight()
        print(json.dumps({**dataclasses.asdict(report), "approvable": report.approvable, "provider": a.provider,
                          "model": ai.model, "routes": [r.key for r in routes.routes]}, indent=2))
        return 0 if report.approvable else 2
    stats = await job.run(approved=True)
    print(json.dumps(dataclasses.asdict(stats), indent=2, default=str))
    return 0 if stats.failed == 0 and stats.status == "COMPLETED" else 1


def routes_need_ai(routes: RoutingConfig) -> bool:
    return len(routes.routes) > 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
