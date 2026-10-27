"""Live per-session evaluation: event model, debounce keys, processor with fail-closed gates."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sci_bq.source import Tenant
from sci_core.budget import BudgetExceeded, BudgetGate, PriceBook
from sci_core.context import build_conversation
from sci_core.engine import EvaluationBudgetExceeded, EvaluationEngine
from sci_core.hashing import canonical_hash, session_content_hash
from sci_core.loader import RubricLoader

log = logging.getLogger("sci.live")  # metadata only


class SessionUpdateEvent(BaseModel):
    """Mirrors contracts/session-update.schema.json."""
    model_config = ConfigDict(extra="forbid", frozen=True)

    event_id: str = Field(min_length=1)
    organization_id: str = Field(min_length=1)
    workspace_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    source_updated_at: datetime
    source_version: str | None = None

    @field_validator("source_updated_at")
    @classmethod
    def _tz_aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("source_updated_at must include a timezone")
        return v

    @property
    def tenant(self) -> Tenant:
        return Tenant(self.organization_id, self.workspace_id)

    def debounce_key(self, window_seconds: int) -> str:
        """Same tenant+session within one time window -> same key -> one Cloud Task."""
        bucket = int(self.source_updated_at.timestamp() // window_seconds)
        return "ev-" + canonical_hash([self.organization_id, self.workspace_id, self.session_id, bucket])[:40]


@dataclass(frozen=True)
class TenantLiveConfig:
    """Explicit allowlist entry: a tenant id in an event alone is never authorization."""
    rubric_id: str
    rubric_version: int | None = None  # None -> latest published
    debounce_seconds: int = 120
    min_reanalysis_seconds: int = 3600  # window for policy.max_analyses_per_session


class Outcome(StrEnum):
    EVALUATED = "EVALUATED"
    DUPLICATE_CONTENT = "DUPLICATE_CONTENT"
    NO_MESSAGES = "NO_MESSAGES"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    BUDGET_BLOCKED = "BUDGET_BLOCKED"
    TOKEN_LIMIT = "TOKEN_LIMIT"


class NotReady(RuntimeError):
    """Source has not caught up with the event yet; retry later (HTTP 503)."""


class UnauthorizedTenant(PermissionError):
    pass


class AIDisabled(RuntimeError):
    pass


class Source(Protocol):
    async def get_session(
        self, tenant: Tenant, session_id: str, *, lookback_days: int = ..., today: date | None = ...
    ) -> dict[str, Any] | None: ...

    async def get_messages(
        self, tenant: Tenant, session_ids: list[str], *, start_date: date, end_date: date
    ) -> dict[str, list[dict[str, Any]]]: ...


class Store(Protocol):
    async def save(self, run: dict[str, Any]) -> None: ...
    async def existing(
        self, tenant: Tenant, rubric_id: str, version: int, session_ids: list[str], *, since: date
    ) -> set[tuple[str, str]]: ...


class Ledger(Protocol):
    async def month_to_date_usd(self, tenant: Tenant, month_start: date) -> float: ...
    async def analyses_since(self, tenant: Tenant, rubric_id: str, version: int, session_id: str, since: datetime) -> int: ...


class Writer(Protocol):
    async def write(self, analyses: list[dict[str, Any]], criteria: list[dict[str, Any]]) -> None: ...


class LiveProcessor:
    def __init__(self, *, tenants: dict[tuple[str, str], TenantLiveConfig], source: Source, store: Store, ledger: Ledger,
                 writer: Writer, loader: RubricLoader, engine: EvaluationEngine | None, prices: PriceBook,
                 max_output_tokens: int = 1500, default_monthly_budget_usd: float = 0.0,
                 dedupe_lookback_days: int = 365, clock: Any = lambda: datetime.now(UTC)) -> None:
        self._tenants, self._src, self._store, self._ledger, self._writer = tenants, source, store, ledger, writer
        self._loader, self._engine, self._prices, self._max_out = loader, engine, prices, max_output_tokens
        self._default_budget, self._lookback, self._clock = default_monthly_budget_usd, dedupe_lookback_days, clock

    def authorize(self, event: SessionUpdateEvent) -> TenantLiveConfig:
        cfg = self._tenants.get((event.organization_id, event.workspace_id))
        if cfg is None:
            raise UnauthorizedTenant("tenant not enabled for live analysis")
        return cfg

    @property
    def ai_enabled(self) -> bool:
        return self._engine is not None

    async def process(self, event: SessionUpdateEvent) -> Outcome:
        cfg = self.authorize(event)
        if self._engine is None:
            raise AIDisabled("live AI analysis is disabled")
        tenant, now = event.tenant, self._clock()
        rubric = await self._loader.load(event.organization_id, event.workspace_id, cfg.rubric_id, cfg.rubric_version)
        session = await self._src.get_session(tenant, event.session_id)
        if session is None:
            # The producer emits events after data is queryable; absence means lag or a bad event -> retry/DLQ.
            raise NotReady("session not visible in source yet")
        if session["updated_at"] < event.source_updated_at:
            raise NotReady("source behind event")
        lo = session["started_at"].date()
        hi = max(t for t in (session.get("closed_at"), session["updated_at"], now) if t).date() + timedelta(days=1)
        messages = (await self._src.get_messages(tenant, [event.session_id], start_date=lo, end_date=hi)).get(event.session_id, [])
        if not messages:
            return await self._trace(event, rubric, Outcome.NO_MESSAGES)
        content_hash = session_content_hash(messages)
        done = await self._store.existing(tenant, rubric.rubric_id, rubric.version, [event.session_id],
                                          since=now.date() - timedelta(days=self._lookback))
        if (event.session_id, content_hash) in done:
            return await self._trace(event, rubric, Outcome.DUPLICATE_CONTENT)  # no AI spend for unchanged content
        cap = rubric.policy.max_analyses_per_session
        if cap is not None:
            recent = await self._ledger.analyses_since(tenant, rubric.rubric_id, rubric.version, event.session_id,
                                                       now - timedelta(seconds=cfg.min_reanalysis_seconds))
            if recent >= cap:
                return await self._trace(event, rubric, Outcome.RATE_LIMITED)
        tokens = build_conversation(messages).approx_tokens
        worst = self._prices.cost(tokens, self._max_out)
        budget = rubric.policy.monthly_budget_usd if rubric.policy.monthly_budget_usd is not None else self._default_budget
        spent = await self._ledger.month_to_date_usd(tenant, now.date().replace(day=1))  # failure -> retry, never skip the gate
        try:
            BudgetGate(cap_usd=budget, spent_usd=spent).reserve(worst)
        except BudgetExceeded:
            return await self._trace(event, rubric, Outcome.BUDGET_BLOCKED)
        try:
            ev = await self._engine.evaluate(organization_id=event.organization_id, workspace_id=event.workspace_id,
                                             session_id=event.session_id, messages=messages, rubric=rubric)
        except EvaluationBudgetExceeded:
            return await self._trace(event, rubric, Outcome.TOKEN_LIMIT)
        analysis, criteria = ev.to_rows()
        await self._writer.write([analysis], criteria)
        return await self._trace(event, rubric, Outcome.EVALUATED, cost=ev.estimated_cost_usd)

    async def _trace(self, event: SessionUpdateEvent, rubric: Any, outcome: Outcome, cost: float = 0.0) -> Outcome:
        """Every handled event leaves a row in analysis_runs (no silent drops)."""
        now = self._clock()
        await self._store.save({
            "run_id": f"live-{event.event_id}", "organization_id": event.organization_id, "workspace_id": event.workspace_id,
            "rubric_id": rubric.rubric_id, "rubric_version": rubric.version, "processing_mode": "live",
            "run_status": outcome.value, "sessions_total": 1, "sessions_processed": int(outcome == Outcome.EVALUATED),
            "sessions_failed": 0, "sessions_skipped": int(outcome != Outcome.EVALUATED), "estimated_cost_usd": cost,
            "actual_cost_usd": cost, "checkpoint": event.session_id, "created_at": now.isoformat(), "finished_at": now.isoformat(),
        })
        log.info("live event handled", extra={"event_id": event.event_id, "session_id": event.session_id, "outcome": outcome.value})
        return outcome
