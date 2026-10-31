"""Runs a validated request with the existing jobs. Same gates as the command line: preflight against the requester's ceiling, then run."""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from datetime import date
from typing import Any

from sci_bq.rubric_repo import BigQueryRubricRepository
from sci_bq.runner import BigQueryRunner
from sci_bq.source import BigQuerySource
from sci_bq.tables import Tables
from sci_bq.writer import BigQueryResultWriter, BigQueryRouteStore, BigQueryRunStore
from sci_console_executor.requests import JobOutcome, RequestRefused, RunRequest
from sci_core.budget import PriceBook
from sci_core.loader import RubricLoader
from sci_core.routing import RoutingConfig, SessionRouter
from sci_core.rubric import RubricError
from sci_openai.pricing import TokenPrices
from sci_workers.ai import ProviderName, build_engine, build_provider
from sci_workers.historical import HistoricalJob, JobConfig
from sci_workers.routing import RoutingJob, RoutingJobConfig


class ExecutorJobs:
    """Provider, model and prices are executor configuration. A request never carries them."""

    def __init__(
        self,
        *,
        tables: Tables,
        location: str,
        key: Callable[[], str],
        provider: ProviderName,
        model: str | None,
        prices: TokenPrices,
        price_book: PriceBook,
        routes: RoutingConfig | None,
        router_max_input_tokens: int = 1200,
    ) -> None:
        self._t, self._key, self._provider, self._model = tables, key, provider, model
        self._prices, self._book, self._routes, self._router_in = prices, price_book, routes, router_max_input_tokens
        self._runner = BigQueryRunner(tables.project, location)
        self._writer = BigQueryResultWriter(tables, location)

    async def run(self, req: RunRequest) -> JobOutcome:
        return await (self._routing(req) if req.kind == "ROUTING" else self._analysis(req))

    @staticmethod
    def _refuse_unless_approvable(report: Any, cap: float, limit: int) -> None:
        if not report.approvable:
            raise RequestRefused(
                f"Pré-voo não aprovado: {report.sessions} sessões (limite {limit}), "
                f"estimativa máxima US$ {report.estimated_cost_usd_high} (teto US$ {cap})."
            )

    async def _routing(self, req: RunRequest) -> JobOutcome:
        if self._routes is None:
            raise RequestRefused("Este executor não tem rotas configuradas (--routes-file).")
        p = req.params
        assert p.start and p.end and p.max_sessions
        ai = build_provider(
            tenant_safety_id=None, key=self._key, prices=self._prices, provider=self._provider, model=self._model, max_output_tokens=200
        )
        cfg = RoutingJobConfig(
            tenant=req.tenant,
            start_date=p.start,
            end_date=p.end,
            prices=self._book,
            max_cost_usd=req.max_cost_usd,
            max_sessions=p.max_sessions,
        )
        job = RoutingJob(
            source=BigQuerySource(self._runner, self._t),
            store=BigQueryRouteStore(self._runner, self._writer, self._t),
            router=SessionRouter(ai, self._routes, max_input_tokens=self._router_in),
            config=cfg,
        )
        report = await job.preflight()
        self._refuse_unless_approvable(report, req.max_cost_usd, p.max_sessions)
        stats = await job.run(approved=True)
        status = stats.status if stats.status != "COMPLETED" or not stats.failed else "COMPLETED_WITH_FAILURES"
        return JobOutcome(
            status,
            {
                "processed": stats.routed,
                "failed": stats.failed,
                "skipped": stats.skipped,
                "spent_usd": round(stats.spent_usd, 6),
                "by_route": stats.by_route,
                "fallbacks": stats.fallbacks,
                "estimate_high_usd": report.estimated_cost_usd_high,
            },
        )

    async def _analysis(self, req: RunRequest) -> JobOutcome:
        p = req.params
        assert p.rubric_id and p.rubric_version
        engine = build_engine(
            mode="historical", tenant_safety_id=None, key=self._key, prices=self._prices, provider=self._provider, model=self._model
        )
        status_filter: str | None = "closed"
        start, end, limit = p.start, p.end, p.max_sessions
        source = BigQuerySource(self._runner, self._t)
        if req.kind == "SESSION_ANALYSIS":
            assert p.session_id
            session = await source.get_session(req.tenant, p.session_id, lookback_days=365)
            if session is None:
                raise RequestRefused("Sessão não encontrada neste workspace (janela de 365 dias).")
            day: date = session["started_at"].date()
            start, end, limit, status_filter = day, day, 1, None
        assert start and end and limit
        cfg = JobConfig(
            tenant=req.tenant,
            rubric_id=p.rubric_id,
            rubric_version=p.rubric_version,
            start_date=start,
            end_date=end,
            prices=self._book,
            max_cost_usd=req.max_cost_usd,
            max_sessions=limit,
            identity=engine.identity,
            status_filter=status_filter,
            only_routed=p.only_routed,
            only_session=p.session_id if req.kind == "SESSION_ANALYSIS" else None,
        )
        job = HistoricalJob(
            source=source,
            store=BigQueryRunStore(self._runner, self._writer, self._t),
            writer=self._writer,
            loader=RubricLoader(BigQueryRubricRepository(self._runner, self._t)),
            engine=engine,
            config=cfg,
            failures=self._writer,
        )
        try:
            report = await job.preflight()
        except RubricError as exc:
            raise RequestRefused("Rubrica indisponível: só uma versão publicada deste workspace pode ser executada.") from exc
        self._refuse_unless_approvable(report, req.max_cost_usd, limit)
        stats = await job.run(approved=True)
        return JobOutcome(
            stats.status,
            {k: v for k, v in dataclasses.asdict(stats).items() if k != "status"}
            | {"processed": stats.processed, "spent_usd": round(stats.spent_usd, 6), "estimate_high_usd": report.estimated_cost_usd_high},
        )
