"""Historical backfill: bounded, checkpointed, idempotent, budget-gated."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from sci_bq.source import Cursor, SessionPage, Tenant
from sci_core.budget import BudgetExceeded, BudgetGate, PriceBook
from sci_core.context import build_conversation
from sci_core.engine import EvaluationBudgetExceeded, EvaluationEngine
from sci_core.hashing import canonical_hash, session_content_hash
from sci_core.loader import RubricLoader
from sci_core.rubric import Rubric

log = logging.getLogger("sci.historical")  # metadata only: never log message content or prompts

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class Source(Protocol):
    async def list_sessions(
        self, tenant: Tenant, *, start_date: date, end_date: date, cursor: Cursor, page_size: int = ..., status: str | None = ...
    ) -> SessionPage: ...

    async def get_messages(
        self, tenant: Tenant, session_ids: list[str], *, start_date: date, end_date: date
    ) -> dict[str, list[dict[str, Any]]]: ...


class RunStore(Protocol):
    async def latest(self, tenant: Tenant, run_id: str) -> dict[str, Any] | None: ...
    async def save(self, run: dict[str, Any]) -> None: ...
    async def existing(
        self, tenant: Tenant, rubric_id: str, version: int, session_ids: list[str], *, since: date
    ) -> set[tuple[str, str]]: ...


class Writer(Protocol):
    async def write(self, analyses: Sequence[dict[str, Any]], criteria: Sequence[dict[str, Any]]) -> None: ...


@dataclass(frozen=True)
class JobConfig:
    tenant: Tenant
    rubric_id: str
    rubric_version: int  # pinned: a job never silently moves to a newer rubric
    start_date: date
    end_date: date
    prices: PriceBook
    max_cost_usd: float  # approved cap
    max_sessions: int  # hard gate on sessions per run
    max_output_tokens_per_session: int = 1500
    page_size: int = 200
    concurrency: int = 4
    status_filter: str | None = "closed"
    dedupe_lookback_days: int = 365

    def __post_init__(self) -> None:
        if self.max_sessions <= 0 or self.max_cost_usd < 0 or self.concurrency <= 0:
            raise ValueError("max_sessions/concurrency must be > 0 and max_cost_usd >= 0")

    @property
    def run_id(self) -> str:
        """Deterministic: re-launching the same job resumes it instead of starting a new one."""
        t = self.tenant
        return "hist-" + canonical_hash([t.organization_id, t.workspace_id, self.rubric_id, self.rubric_version,
                                         self.start_date.isoformat(), self.end_date.isoformat()])[:24]


@dataclass
class RunStats:
    seen: int = 0
    processed: int = 0
    failed: int = 0
    skipped: int = 0
    spent_usd: float = 0.0
    estimated_usd: float = 0.0
    input_tokens: int = 0


@dataclass(frozen=True)
class PreflightReport:
    sessions: int
    sessions_with_messages: int
    already_analysed: int
    to_process: int
    approx_input_tokens: int
    estimated_cost_usd_low: float  # input only
    estimated_cost_usd_high: float  # input + max output
    within_budget: bool
    within_session_gate: bool

    @property
    def approvable(self) -> bool:
        return self.within_budget and self.within_session_gate


def _checkpoint_dump(c: Cursor) -> str:
    return json.dumps({"updated_at": c.updated_at.isoformat(), "session_id": c.session_id})


def _checkpoint_load(raw: str | None) -> Cursor:
    if not raw:
        return Cursor(EPOCH)
    d = json.loads(raw)
    return Cursor(datetime.fromisoformat(d["updated_at"]), d["session_id"])


def _message_window(sessions: Sequence[dict[str, Any]]) -> tuple[date, date]:
    starts = [s["started_at"].date() for s in sessions]
    ends = [max(t for t in (s.get("closed_at"), s["updated_at"]) if t).date() for s in sessions]
    return min(starts), max(ends) + timedelta(days=1)


class HistoricalJob:
    def __init__(self, *, source: Source, store: RunStore, writer: Writer, loader: RubricLoader,
                 engine: EvaluationEngine | None, config: JobConfig,
                 clock: Any = lambda: datetime.now(UTC)) -> None:
        self._src, self._store, self._writer, self._loader = source, store, writer, loader
        self._engine, self._cfg, self._clock = engine, config, clock

    async def _pages(self, cursor: Cursor):  # type: ignore[no-untyped-def]
        cfg = self._cfg
        while True:
            page = await self._src.list_sessions(
                cfg.tenant, start_date=cfg.start_date, end_date=cfg.end_date, cursor=cursor,
                page_size=cfg.page_size, status=cfg.status_filter)
            if page.sessions:
                yield page
            if page.next_cursor is None:
                return
            cursor = page.next_cursor

    async def _prepare(
        self, sessions: list[dict[str, Any]], rubric: Rubric
    ) -> tuple[list[tuple[dict[str, Any], list[dict[str, Any]], str]], int, int]:
        """Returns (todo, skipped_empty, already_done)."""
        cfg = self._cfg
        lo, hi = _message_window(sessions)
        ids = [s["session_id"] for s in sessions]
        msgs = await self._src.get_messages(cfg.tenant, ids, start_date=lo, end_date=hi)
        since = self._clock().date() - timedelta(days=cfg.dedupe_lookback_days)
        done = await self._store.existing(cfg.tenant, rubric.rubric_id, rubric.version, ids, since=since)
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

    def _estimate(self, messages: list[dict[str, Any]]) -> tuple[int, float]:
        tokens = build_conversation(messages).approx_tokens
        return tokens, self._cfg.prices.cost(tokens, self._cfg.max_output_tokens_per_session)

    async def preflight(self) -> PreflightReport:
        """Reads sessions/messages (bounded by max_sessions) but never calls the AI provider."""
        cfg = self._cfg
        rubric = await self._loader.load(cfg.tenant.organization_id, cfg.tenant.workspace_id, cfg.rubric_id, cfg.rubric_version)
        seen = with_msgs = dup = 0
        tokens = 0
        low = high = 0.0
        cursor = _checkpoint_load((await self._store.latest(cfg.tenant, cfg.run_id) or {}).get("checkpoint"))
        async for page in self._pages(cursor):
            sessions = page.sessions[: cfg.max_sessions - seen + 1]  # +1 detects overflow of the gate
            todo, empty, d = await self._prepare(sessions, rubric)
            seen += len(sessions)
            with_msgs += len(sessions) - empty
            dup += d
            for _, m, _ in todo:
                t, c_high = self._estimate(m)
                tokens += t
                low += cfg.prices.cost(t, 0)
                high += c_high
            if seen > cfg.max_sessions:
                break
        return PreflightReport(
            sessions=seen, sessions_with_messages=with_msgs, already_analysed=dup, to_process=with_msgs - dup,
            approx_input_tokens=tokens, estimated_cost_usd_low=round(low, 6), estimated_cost_usd_high=round(high, 6),
            within_budget=high <= cfg.max_cost_usd, within_session_gate=seen <= cfg.max_sessions)

    async def run(self, *, approved: bool = False) -> RunStats:
        """Executes the backfill. Requires explicit approval and an engine (real or fake)."""
        cfg = self._cfg
        if not approved:
            raise PermissionError("run() requires approved=True after preflight review")
        if self._engine is None:
            raise RuntimeError("no evaluation engine configured")
        rubric = await self._loader.load(cfg.tenant.organization_id, cfg.tenant.workspace_id, cfg.rubric_id, cfg.rubric_version)
        prev = await self._store.latest(cfg.tenant, cfg.run_id)
        if prev and prev.get("run_status") == "COMPLETED":
            log.info("run %s already completed", cfg.run_id)
            return RunStats()
        stats = RunStats()
        if prev:  # resume counters
            stats.processed = int(prev.get("sessions_processed") or 0)
            stats.failed = int(prev.get("sessions_failed") or 0)
            stats.skipped = int(prev.get("sessions_skipped") or 0)
            stats.seen = int(prev.get("sessions_total") or 0)
            stats.spent_usd = float(prev.get("actual_cost_usd") or 0)
        gate = BudgetGate(cap_usd=cfg.max_cost_usd, spent_usd=stats.spent_usd)
        cursor = _checkpoint_load(prev.get("checkpoint") if prev else None)
        status = "COMPLETED"
        try:
            async for page in self._pages(cursor):
                if stats.seen + len(page.sessions) > cfg.max_sessions:
                    status = "SESSION_GATE_STOPPED"  # whole page or nothing: checkpoint stays consistent
                    break
                await self._process_page(page, rubric, gate, stats)
                cursor = Cursor(page.sessions[-1]["updated_at"], page.sessions[-1]["session_id"])
                await self._save(stats, gate, cursor, "RUNNING")  # results are durable before the checkpoint
        except BudgetExceeded:
            status = "BUDGET_STOPPED"
        except Exception:
            await self._save(stats, gate, cursor, "FAILED", finished=True)
            raise
        await self._save(stats, gate, cursor, status, finished=True)
        return stats

    async def _process_page(self, page: SessionPage, rubric: Rubric, gate: BudgetGate, stats: RunStats) -> None:
        todo, empty, dup = await self._prepare(page.sessions, rubric)
        stats.seen += len(page.sessions)
        stats.skipped += empty + dup
        sem = asyncio.Semaphore(self._cfg.concurrency)
        results: list[Any] = []
        stop: list[BudgetExceeded] = []

        async def one(session: dict[str, Any], messages: list[dict[str, Any]]) -> None:
            assert self._engine is not None
            tokens, worst = self._estimate(messages)
            async with sem:
                if stop:
                    return
                try:
                    token = gate.reserve(worst)
                except BudgetExceeded as exc:
                    stop.append(exc)
                    return
                stats.estimated_usd += worst
                try:
                    ev = await self._engine.evaluate(
                        organization_id=self._cfg.tenant.organization_id, workspace_id=self._cfg.tenant.workspace_id,
                        session_id=session["session_id"], messages=messages, rubric=rubric)
                except EvaluationBudgetExceeded:
                    gate.settle(token, 0.0)  # rejected before any provider call
                    stats.skipped += 1
                    return
                except Exception as exc:
                    gate.settle(token, None)  # unknown outcome: keep worst case charged
                    stats.failed += 1
                    log.warning("session failed", extra={"session_id": session["session_id"], "error": type(exc).__name__})
                    return
                gate.settle(token, ev.estimated_cost_usd)
                stats.input_tokens += ev.input_tokens
                results.append(ev)

        await asyncio.gather(*(one(s, m) for s, m, _ in todo))
        if results:  # write what completed even when the budget stopped the page midway
            rows = [ev.to_rows() for ev in results]
            await self._writer.write([a for a, _ in rows], [c for _, cs in rows for c in cs])
            stats.processed += len(results)
        stats.spent_usd = gate.spent_usd
        if stop:
            raise stop[0]

    async def _save(self, stats: RunStats, gate: BudgetGate, cursor: Cursor, status: str, *, finished: bool = False) -> None:
        cfg, now = self._cfg, self._clock()
        await self._store.save({
            "run_id": cfg.run_id, "organization_id": cfg.tenant.organization_id, "workspace_id": cfg.tenant.workspace_id,
            "rubric_id": cfg.rubric_id, "rubric_version": cfg.rubric_version, "processing_mode": "historical",
            "run_status": status, "sessions_total": stats.seen, "sessions_processed": stats.processed,
            "sessions_failed": stats.failed, "sessions_skipped": stats.skipped,
            "estimated_cost_usd": round(stats.estimated_usd, 6), "actual_cost_usd": round(gate.spent_usd, 6),
            "checkpoint": _checkpoint_dump(cursor), "created_at": now.isoformat(),
            "finished_at": now.isoformat() if finished else None,
        })
