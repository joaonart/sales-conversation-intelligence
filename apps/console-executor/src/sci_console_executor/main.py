"""Executor entrypoint. `list` never claims anything and never calls an AI provider; `once` is gated by AI_ENABLED and an OpenAI key."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path

from sci_bq.ledger import BigQueryLedger
from sci_bq.runner import BigQueryRunner
from sci_bq.source import Tenant
from sci_bq.tables import Tables
from sci_console_executor.jobs import ExecutorJobs
from sci_console_executor.requests import BigQueryRequestStore, JobOutcome, RequestExecutor, RunRequest
from sci_console_executor.schedules import BigQueryScheduleStore, ScheduleMaterializer
from sci_core.budget import PriceBook
from sci_core.obs import configure_logging
from sci_core.routing import RoutingConfig, RoutingError
from sci_openai.catalog import UnknownModel, find
from sci_openai.pricing import LUNA_STANDARD_SHORT, TokenPrices
from sci_workers.ai import PROVIDERS, MissingApiKey, api_key_provider


class _NoJobs:
    """`list` never runs anything."""

    async def run(self, req: RunRequest) -> JobOutcome:
        raise RuntimeError("list does not run jobs")


def _tenant(text: str) -> Tenant:
    org, _, ws = text.partition("/")
    if not org or not ws:
        raise argparse.ArgumentTypeError("use organization/workspace")
    return Tenant(org, ws)


def parse(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Executes the execution requests made in the admin console")
    p.add_argument("mode", choices=["list", "once"])
    p.add_argument("--project", default=os.environ.get("GCP_PROJECT"), required=not os.environ.get("GCP_PROJECT"))
    p.add_argument("--location", default=os.environ.get("BQ_LOCATION", "US"))
    p.add_argument("--source-dataset", default="commerce")
    p.add_argument("--config-dataset", default="conversation_config")
    p.add_argument("--analytics-dataset", default="conversation_analytics")
    p.add_argument("--tenant", type=_tenant, action="append", required=True, help="organization/workspace; only these tenants are served")
    p.add_argument("--limit", type=int, default=3, help="requests per invocation")
    p.add_argument("--max-cost-ceiling", type=float, default=1.0, help="refuse requests whose ceiling is above this (US$)")
    p.add_argument("--max-sessions-ceiling", type=int, default=1000)
    p.add_argument(
        "--monthly-budget-usd",
        type=float,
        default=float(os.environ.get("EXECUTOR_MONTHLY_BUDGET_USD") or 0),
        help="the most AI spend a workspace may reach in a month, counting everything recorded (required to run requests)",
    )
    p.add_argument("--routes-file", type=Path, default=None, help="routes for ROUTING requests (see docs/routing.md)")
    p.add_argument("--router-max-input-tokens", type=int, default=1200)
    p.add_argument("--provider", choices=PROVIDERS, default=os.environ.get("AI_PROVIDER", "decisions"))
    p.add_argument("--responses-model", default=os.environ.get("RESPONSES_MODEL"))
    p.add_argument(
        "--summary-model",
        default=os.environ.get("EXECUTOR_SUMMARY_MODEL") or None,
        help="a responses model of the closed catalog that writes the general evaluation of rubrics that ask for one (default: none)",
    )
    p.add_argument("--input-price-per-million", type=float, default=None)
    p.add_argument("--output-price-per-million", type=float, default=None)
    p.add_argument("--cached-input-price-per-million", type=float, default=None)
    a = p.parse_args(argv)
    if a.mode == "once" and (a.input_price_per_million is None or a.output_price_per_million is None):
        p.error("once requires --input-price-per-million and --output-price-per-million (from official current pricing)")
    if a.provider == "responses" and not a.responses_model:
        p.error("--provider responses requires --responses-model")
    return a


def load_routes(path: Path | None, env: Mapping[str, str] | None = None) -> RoutingConfig | None:
    """Routes for ROUTING requests: a file (`--routes-file`) or, in a Cloud Run Job, the JSON in `SCI_ROUTES_JSON`.

    Neither: routing requests are refused."""
    env = os.environ if env is None else env
    raw = path.read_text(encoding="utf-8") if path else env.get("SCI_ROUTES_JSON", "").strip()
    return RoutingConfig.parse(json.loads(raw)) if raw else None


async def main(argv: list[str] | None = None) -> int:
    a = parse(argv)
    configure_logging(logging.INFO)
    tables = Tables(a.project, a.source_dataset, a.config_dataset, a.analytics_dataset)
    runner = BigQueryRunner(a.project, a.location)
    store = BigQueryRequestStore(runner, a.project, a.config_dataset)
    executor_id = f"executor-{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
    peek = RequestExecutor(
        store=store,
        jobs=_NoJobs(),
        executor_id=executor_id,
        max_cost_ceiling=a.max_cost_ceiling,
        max_sessions_ceiling=a.max_sessions_ceiling,
    )
    if a.mode == "once" and os.environ.get("AI_ENABLED") == "true":
        # Due schedules become ordinary requests first. This only writes request rows (no key, no provider call); with the AI gate closed no
        # request would run, so none is created.
        await ScheduleMaterializer(BigQueryScheduleStore(runner, a.project, a.config_dataset)).run(a.tenant)
    waiting = await peek.list_pending(a.tenant, a.limit)
    if a.mode == "list":
        print(json.dumps(waiting, indent=2, default=str))
        return 0
    # An idle poll needs neither the AI gate nor the key: with nothing waiting there is nothing to refuse,
    # so a scheduled job stays quiet and green.
    if not waiting:
        print("[]")
        return 0
    if os.environ.get("AI_ENABLED") != "true":
        print(
            f"refusing to run: {len(waiting)} request(s) waiting but AI_ENABLED is not true "
            "(the request in the console is the first gate, this is the second)",
            file=sys.stderr,
        )
        return 3
    if a.provider == "decisions":
        floor = LUNA_STANDARD_SHORT.worst_case_price_book()
        if a.input_price_per_million < floor.input_per_million or a.output_price_per_million < floor.output_per_million:
            print("refusing to run: budget prices are below the validated worst-case rates", file=sys.stderr)
            return 5
    if a.monthly_budget_usd <= 0:
        print("refusing to run: set the monthly AI budget (--monthly-budget-usd or EXECUTOR_MONTHLY_BUDGET_USD)", file=sys.stderr)
        return 7
    try:
        key = api_key_provider()
    except (MissingApiKey, OSError) as exc:
        print(f"refusing to run: {type(exc).__name__}", file=sys.stderr)
        return 6
    if a.summary_model:
        try:
            find("responses", a.summary_model)  # a model outside the closed list stops the job before any request is touched
        except UnknownModel as exc:
            print(f"refusing to run: {exc}", file=sys.stderr)
            return 8
    try:
        routes = load_routes(a.routes_file)
    except (OSError, ValueError, RoutingError) as exc:
        print(f"invalid routes: {exc}", file=sys.stderr)
        return 4
    prices = LUNA_STANDARD_SHORT
    if a.provider == "responses":
        prices = TokenPrices(
            a.input_price_per_million,
            a.cached_input_price_per_million or a.input_price_per_million,
            a.input_price_per_million,
            a.output_price_per_million,
            source="cli",
        )
    jobs = ExecutorJobs(
        tables=tables,
        location=a.location,
        key=key,
        provider=a.provider,
        model=a.responses_model,
        prices=prices,
        price_book=PriceBook(a.input_price_per_million, a.output_price_per_million),
        routes=routes,
        router_max_input_tokens=a.router_max_input_tokens,
        summary_model=a.summary_model,
    )
    ex = RequestExecutor(
        store=store,
        jobs=jobs,
        executor_id=executor_id,
        max_cost_ceiling=a.max_cost_ceiling,
        max_sessions_ceiling=a.max_sessions_ceiling,
        ledger=BigQueryLedger(runner, tables),
        monthly_budget_usd=a.monthly_budget_usd,
    )
    results = await ex.run_once(a.tenant, a.limit)
    print(json.dumps([{"request_id": r, "status": s} for r, s in results], indent=2))
    return 0  # a request that ended FAILED is recorded on the request itself; the job only fails when it could not run at all


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
