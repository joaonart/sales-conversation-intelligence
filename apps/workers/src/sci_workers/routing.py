"""Routing pass: decides, once per session and content, which rubric the session is analysed with. Bounded, idempotent, budget-gated.

It runs before the rubric jobs. Each rubric job then takes only the sessions routed to it (`historical_main --only-routed`), so its
preflight is exact and no session is paid for by a rubric that does not fit it. A re-run classifies only what changed: (session, content
hash) pairs already decided under the same router identity (model + prompt + route definitions) are skipped without any provider call.
"""
from __future__ import annotations

import asyncio
import logging
from collections import Counter
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from sci_bq.source import Cursor, SessionPage, Tenant
from sci_core.budget import BudgetExceeded, BudgetGate, PriceBook
from sci_core.hashing import canonical_hash, session_content_hash
from sci_core.provider import AnalysisIdentity
from sci_core.routing import RouteDecision, SessionRouter
from sci_core.tracing import span
from sci_workers.failures import FailureSink, failure_row
from sci_workers.historical import EPOCH, Source, message_window

log = logging.getLogger("sci.routing")  # metadata only: never log message content or prompts


class RouteStore(Protocol):
    async def existing(
        self, tenant: Tenant, session_ids: list[str], *, since: date, identity: AnalysisIdentity
    ) -> set[tuple[str, str]]: ...

    async def write(self, rows: Sequence[dict[str, Any]]) -> None: ...


@dataclass(frozen=True)
class RoutingJobConfig:
    tenant: Tenant
    start_date: date
    end_date: date
    prices: PriceBook
    max_cost_usd: float  # approved cap
    max_sessions: int  # hard gate on sessions per run
    max_output_tokens: int = 200  # a single CHOICE answer; part of the worst case reserved before each call
    page_size: int = 200
    concurrency: int = 4
    status_filter: str | None = "closed"
    dedupe_lookback_days: int = 365

    def __post_init__(self) -> None:
        if self.max_sessions <= 0 or self.max_cost_usd < 0 or self.concurrency <= 0:
            raise ValueError("max_sessions/concurrency must be > 0 and max_cost_usd >= 0")


@dataclass
class RoutingStats:
    seen: int = 0
    routed: int = 0
    failed: int = 0
    skipped: int = 0
    spent_usd: float = 0.0
    by_route: dict[str, int] = field(default_factory=dict)  # a plain dict: dataclasses.asdict rebuilds a Counter wrongly
    fallbacks: int = 0
    failure_codes: dict[str, int] = field(default_factory=dict)  # why sessions failed, by closed code (see sci_workers.failures)
    status: str = "COMPLETED"  # or BUDGET_STOPPED / SESSION_GATE_STOPPED: a rerun continues, decided sessions are skipped


@dataclass(frozen=True)
class RoutingPreflight:
    sessions: int
    sessions_with_messages: int
    already_routed: int
    to_classify: int
    approx_input_tokens: int
    estimated_cost_usd_low: float  # input only
    estimated_cost_usd_high: float  # input + max output
    within_budget: bool
    within_session_gate: bool
    needs_ai: bool

    @property
    def approvable(self) -> bool:
        return self.within_budget and self.within_session_gate


def route_row(
    tenant: Tenant, session_id: str, content_hash: str, d: RouteDecision, identity: AnalysisIdentity, now: datetime
) -> dict[str, Any]:
    """Deterministic `route_id`: a retried write of the same decision is the same logical row."""
    rid = canonical_hash(
        [tenant.organization_id, tenant.workspace_id, session_id, content_hash, identity.model, identity.prompt_version])[:32]
    return {
        "route_id": rid, "organization_id": tenant.organization_id, "workspace_id": tenant.workspace_id,
        "session_id": session_id, "session_content_hash": content_hash, "route_key": d.route_key,
        "rubric_id": d.rubric_id, "rubric_version": d.rubric_version, "route_state": d.state.value,
        "model": identity.model, "prompt_version": identity.prompt_version, "input_tokens": d.input_tokens,
        "output_tokens": d.output_tokens, "estimated_cost_usd": round(d.estimated_cost_usd, 8), "decided_at": now.isoformat(),
    }


class RoutingJob:
    def __init__(self, *, source: Source, store: RouteStore, router: SessionRouter, config: RoutingJobConfig,
                 clock: Any = lambda: datetime.now(UTC), failures: FailureSink | None = None) -> None:
        self._src, self._store, self._router, self._cfg, self._clock = source, store, router, config, clock
        self._failures = failures
        t = config.tenant
        # No run row exists for a routing pass; this id groups its failures (same window and router identity -> same id).
        ident = router.identity
        self.run_id = "route-" + canonical_hash(
            [t.organization_id, t.workspace_id, config.start_date.isoformat(), config.end_date.isoformat(),
             ident.model, ident.prompt_version])[:24]

    async def _pages(self) -> AsyncIterator[SessionPage]:
        cfg, cursor = self._cfg, Cursor(EPOCH)
        while True:
            page = await self._src.list_sessions(cfg.tenant, start_date=cfg.start_date, end_date=cfg.end_date, cursor=cursor,
                                                 page_size=cfg.page_size, status=cfg.status_filter)
            if page.sessions:
                yield page
            if page.next_cursor is None:
                return
            cursor = page.next_cursor

    async def _prepare(self, sessions: list[dict[str, Any]]) -> tuple[list[tuple[dict[str, Any], list[dict[str, Any]], str]], int, int]:
        """Returns (todo, skipped_empty, already_routed)."""
        cfg = self._cfg
        lo, hi = message_window(sessions)
        ids = [s["session_id"] for s in sessions]
        msgs = await self._src.get_messages(cfg.tenant, ids, start_date=lo, end_date=hi)
        since = self._clock().date() - timedelta(days=cfg.dedupe_lookback_days)
        done = await self._store.existing(cfg.tenant, ids, since=since, identity=self._router.identity)
        todo, empty, dup = [], 0, 0
        for s in sessions:
            m = msgs.get(s["session_id"], [])
            if not m:
                empty += 1
                continue
            h = session_content_hash(m)
            if (s["session_id"], h) in done:
                dup += 1
                continue
            todo.append((s, m, h))
        return todo, empty, dup

    def _worst_case(self, messages: list[dict[str, Any]]) -> tuple[int, float]:
        if not self._router.needs_ai:
            return 0, 0.0  # a single route is decided locally: nothing to reserve or pay
        tokens = self._router.estimate_input_tokens(messages)
        return tokens, self._cfg.prices.cost(tokens, self._cfg.max_output_tokens)

    async def preflight(self) -> RoutingPreflight:
        """Reads sessions/messages (bounded by max_sessions) but never calls the AI provider."""
        cfg = self._cfg
        seen = with_msgs = dup = tokens = 0
        low = high = 0.0
        async for page in self._pages():
            sessions = page.sessions[: cfg.max_sessions - seen + 1]  # +1 detects overflow of the gate
            todo, empty, d = await self._prepare(sessions)
            seen += len(sessions)
            with_msgs += len(sessions) - empty
            dup += d
            for _, m, _ in todo:
                t, worst = self._worst_case(m)
                tokens += t
                low += cfg.prices.cost(t, 0)
                high += worst
            if seen > cfg.max_sessions:
                break
        return RoutingPreflight(
            sessions=seen, sessions_with_messages=with_msgs, already_routed=dup, to_classify=with_msgs - dup, approx_input_tokens=tokens,
            estimated_cost_usd_low=round(low, 6), estimated_cost_usd_high=round(high, 6), within_budget=high <= cfg.max_cost_usd,
            within_session_gate=seen <= cfg.max_sessions, needs_ai=self._router.needs_ai)

    async def run(self, *, approved: bool = False) -> RoutingStats:
        if not approved:
            raise PermissionError("run() requires approved=True after preflight review")
        cfg, stats = self._cfg, RoutingStats()
        gate = BudgetGate(cap_usd=cfg.max_cost_usd)
        try:
            async for page in self._pages():
                if stats.seen + len(page.sessions) > cfg.max_sessions:
                    stats.status = "SESSION_GATE_STOPPED"  # whole page or nothing
                    break
                with span("sci.routing.page", sessions=len(page.sessions)):
                    await self._process_page(page, gate, stats)
        except BudgetExceeded:
            stats.status = "BUDGET_STOPPED"
        stats.spent_usd = gate.spent_usd
        return stats

    async def _process_page(self, page: SessionPage, gate: BudgetGate, stats: RoutingStats) -> None:
        todo, empty, dup = await self._prepare(page.sessions)
        stats.seen += len(page.sessions)
        stats.skipped += empty + dup
        sem = asyncio.Semaphore(self._cfg.concurrency)
        rows: list[dict[str, Any]] = []
        failed_rows: list[dict[str, Any]] = []
        decided: list[RouteDecision] = []
        stop: list[BudgetExceeded] = []
        identity = self._router.identity

        async def one(session: dict[str, Any], messages: list[dict[str, Any]], content_hash: str) -> None:
            _, worst = self._worst_case(messages)
            async with sem:
                if stop:
                    return
                try:
                    token = gate.reserve(worst)
                except BudgetExceeded as exc:
                    stop.append(exc)
                    return
                try:
                    d = await self._router.classify(messages)
                except Exception as exc:
                    gate.settle(token, None)  # unknown outcome: keep the worst case charged
                    stats.failed += 1
                    row = failure_row(self._cfg.tenant, self.run_id, session["session_id"], "ROUTING", exc, self._clock())
                    failed_rows.append(row)
                    stats.failure_codes[row["error_code"]] = stats.failure_codes.get(row["error_code"], 0) + 1
                    log.warning("routing failed", extra={"event": "routing_failed", "session_id": session["session_id"],
                                                         "error_type": type(exc).__name__})
                    return
                gate.settle(token, d.estimated_cost_usd)
                decided.append(d)
                rows.append(route_row(self._cfg.tenant, session["session_id"], content_hash, d, identity, self._clock()))

        await asyncio.gather(*(one(s, m, h) for s, m, h in todo))
        if failed_rows and self._failures is not None:
            try:
                await self._failures.write_failures(failed_rows)
            except Exception as exc:  # losing the explanation must never stop the pass (the counters stay)
                log.warning("could not record failures", extra={"event": "failures_not_recorded", "error_type": type(exc).__name__})
        if rows:  # write what completed even when the budget stopped the page midway
            await self._store.write(rows)
            stats.routed += len(rows)
            for k, n in Counter(d.route_key for d in decided).items():
                stats.by_route[k] = stats.by_route.get(k, 0) + n
            stats.fallbacks += sum(1 for d in decided if d.state.value == "FALLBACK")
        stats.spent_usd = gate.spent_usd
        if stop:
            raise stop[0]
