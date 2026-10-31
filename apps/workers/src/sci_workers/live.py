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
from sci_core.obs import Stopwatch
from sci_core.provider import AIProvider, AnalysisIdentity
from sci_core.routing import RouteDecision, RouteState, RoutingConfig, SessionRouter
from sci_core.tracing import span
from sci_workers.routing import route_row

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
    """Explicit allowlist entry: a tenant id in an event alone is never authorization.

    Either one fixed rubric (`rubric_id`) or a `routing` config that picks the rubric per session (never both)."""
    rubric_id: str | None = None
    rubric_version: int | None = None  # None -> latest published
    debounce_seconds: int = 120
    min_reanalysis_seconds: int = 3600  # window for policy.max_analyses_per_session
    routing: RoutingConfig | None = None

    def __post_init__(self) -> None:
        if (self.rubric_id is None) == (self.routing is None):
            raise ValueError("a tenant needs exactly one of rubric_id or routing")


class Outcome(StrEnum):
    EVALUATED = "EVALUATED"
    DUPLICATE_CONTENT = "DUPLICATE_CONTENT"
    NO_MESSAGES = "NO_MESSAGES"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    RATE_LIMITED = "RATE_LIMITED"
    BUDGET_BLOCKED = "BUDGET_BLOCKED"
    TOKEN_LIMIT = "TOKEN_LIMIT"
    ROUTED_SKIP = "ROUTED_SKIP"  # the router sent the session to no rubric: decided, recorded, nothing more to pay


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
        self, tenant: Tenant, rubric_id: str, version: int, session_ids: list[str], *, since: date, identity: AnalysisIdentity
    ) -> set[tuple[str, str]]: ...


class Ledger(Protocol):
    async def month_to_date_usd(self, tenant: Tenant, month_start: date) -> float: ...
    async def analyses_since(self, tenant: Tenant, rubric_id: str, version: int, session_id: str, since: datetime) -> int: ...


class Writer(Protocol):
    async def write(self, analyses: list[dict[str, Any]], criteria: list[dict[str, Any]]) -> None: ...


class RouteStore(Protocol):
    async def route_for(
        self, tenant: Tenant, session_id: str, content_hash: str, *, since: date, identity: AnalysisIdentity
    ) -> dict[str, Any] | None: ...

    async def write(self, rows: list[dict[str, Any]]) -> None: ...


class LiveProcessor:
    def __init__(self, *, tenants: dict[tuple[str, str], TenantLiveConfig], source: Source, store: Store, ledger: Ledger,
                 writer: Writer, loader: RubricLoader, engine: EvaluationEngine | None, prices: PriceBook,
                 max_output_tokens: int = 1500, default_monthly_budget_usd: float = 0.0,
                 dedupe_lookback_days: int = 365, clock: Any = lambda: datetime.now(UTC),
                 router_provider: AIProvider | None = None, route_store: RouteStore | None = None,
                 router_max_input_tokens: int = 1200, router_max_output_tokens: int = 200) -> None:
        if engine is not None and any(c.routing for c in tenants.values()) and (router_provider is None or route_store is None):
            raise ValueError("tenants with routing need router_provider and route_store")
        self._tenants, self._src, self._store, self._ledger, self._writer = tenants, source, store, ledger, writer
        self._loader, self._engine, self._prices, self._max_out = loader, engine, prices, max_output_tokens
        self._default_budget, self._lookback, self._clock = default_monthly_budget_usd, dedupe_lookback_days, clock
        self._router_ai, self._routes = router_provider, route_store
        self._router_in, self._router_out = router_max_input_tokens, router_max_output_tokens

    def authorize(self, event: SessionUpdateEvent) -> TenantLiveConfig:
        cfg = self._tenants.get((event.organization_id, event.workspace_id))
        if cfg is None:
            raise UnauthorizedTenant("tenant not enabled for live analysis")
        return cfg

    @property
    def ai_enabled(self) -> bool:
        return self._engine is not None

    async def process(self, event: SessionUpdateEvent) -> Outcome:
        watch = Stopwatch()
        with span("sci.live.process", event_id=event.event_id):
            return await self._process(event, watch)

    async def _process(self, event: SessionUpdateEvent, watch: Stopwatch) -> Outcome:
        cfg = self.authorize(event)
        if self._engine is None:
            raise AIDisabled("live AI analysis is disabled")
        tenant, now = event.tenant, self._clock()
        rubric = (await self._loader.load(event.organization_id, event.workspace_id, cfg.rubric_id, cfg.rubric_version)
                  if cfg.rubric_id else None)  # with routing the rubric is only known after the session was classified
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
            return await self._trace(event, rubric, Outcome.NO_MESSAGES, watch=watch)
        content_hash = session_content_hash(messages)
        route_cost = 0.0
        if cfg.routing:
            decision, route_cost, blocked = await self._route(event, cfg.routing, messages, content_hash, now)
            if blocked:
                return await self._trace(event, None, Outcome.BUDGET_BLOCKED, watch=watch)
            if decision.rubric_id is None:
                return await self._trace(event, None, Outcome.ROUTED_SKIP, cost=route_cost, watch=watch)
            rubric = await self._loader.load(event.organization_id, event.workspace_id, decision.rubric_id, decision.rubric_version)
        assert rubric is not None
        done = await self._store.existing(tenant, rubric.rubric_id, rubric.version, [event.session_id],
                                          since=now.date() - timedelta(days=self._lookback), identity=self._engine.identity)
        if (event.session_id, content_hash) in done:
            # unchanged content: no analysis spend (the routing cost, if it was paid just now, is still recorded)
            return await self._trace(event, rubric, Outcome.DUPLICATE_CONTENT, cost=route_cost, watch=watch)
        cap = rubric.policy.max_analyses_per_session
        if cap is not None:
            recent = await self._ledger.analyses_since(tenant, rubric.rubric_id, rubric.version, event.session_id,
                                                       now - timedelta(seconds=cfg.min_reanalysis_seconds))
            if recent >= cap:
                return await self._trace(event, rubric, Outcome.RATE_LIMITED, watch=watch)
        tokens = build_conversation(messages).approx_tokens
        worst = self._prices.cost(tokens, self._max_out)
        budget = rubric.policy.monthly_budget_usd if rubric.policy.monthly_budget_usd is not None else self._default_budget
        spent = await self._ledger.month_to_date_usd(tenant, now.date().replace(day=1))  # failure -> retry, never skip the gate
        try:
            BudgetGate(cap_usd=budget, spent_usd=spent).reserve(worst)
        except BudgetExceeded:
            return await self._trace(event, rubric, Outcome.BUDGET_BLOCKED, watch=watch)
        try:
            ev = await self._engine.evaluate(organization_id=event.organization_id, workspace_id=event.workspace_id,
                                             session_id=event.session_id, messages=messages, rubric=rubric)
        except EvaluationBudgetExceeded:
            return await self._trace(event, rubric, Outcome.TOKEN_LIMIT, watch=watch)
        analysis, criteria = ev.to_rows()
        await self._writer.write([analysis], criteria)
        return await self._trace(event, rubric, Outcome.EVALUATED, cost=ev.estimated_cost_usd + route_cost, watch=watch)

    async def _route(
        self, event: SessionUpdateEvent, routing: RoutingConfig, messages: list[dict[str, Any]], content_hash: str, now: datetime
    ) -> tuple[RouteDecision, float, bool]:
        """(decision, cost paid now, blocked). A decision already recorded for this content and router identity costs nothing."""
        assert self._router_ai is not None and self._routes is not None
        tenant = event.tenant
        router = SessionRouter(self._router_ai, routing, max_input_tokens=self._router_in)
        cached = await self._routes.route_for(tenant, event.session_id, content_hash,
                                              since=now.date() - timedelta(days=self._lookback), identity=router.identity)
        if cached:
            return (RouteDecision(route_key=cached["route_key"], rubric_id=cached["rubric_id"], rubric_version=cached["rubric_version"],
                                  state=RouteState(cached["route_state"])), 0.0, False)
        if router.needs_ai:
            worst = self._prices.cost(router.estimate_input_tokens(messages), self._router_out)
            budget = self._default_budget  # the rubric (and its own budget) is not known yet: the deployment-wide cap applies
            spent = await self._ledger.month_to_date_usd(tenant, now.date().replace(day=1))  # failure -> retry, never skip the gate
            try:
                BudgetGate(cap_usd=budget, spent_usd=spent).reserve(worst)
            except BudgetExceeded:
                fb = routing.route(routing.fallback)  # nothing was classified; the caller records BUDGET_BLOCKED and retries later
                return RouteDecision(route_key=fb.key, rubric_id=fb.rubric_id, rubric_version=fb.rubric_version,
                                     state=RouteState.FALLBACK), 0.0, True
        decision = await router.classify(messages)
        await self._routes.write([route_row(tenant, event.session_id, content_hash, decision, router.identity, now)])
        return decision, decision.estimated_cost_usd, False

    async def _trace(self, event: SessionUpdateEvent, rubric: Any | None, outcome: Outcome, cost: float = 0.0,
                     watch: Stopwatch | None = None) -> Outcome:
        """Every handled event leaves a row in analysis_runs (no silent drops)."""
        now = self._clock()
        await self._store.save({
            "run_id": f"live-{event.event_id}", "organization_id": event.organization_id, "workspace_id": event.workspace_id,
            "rubric_id": rubric.rubric_id if rubric else None, "rubric_version": rubric.version if rubric else None,
            "processing_mode": "live",
            "run_status": outcome.value, "sessions_total": 1, "sessions_processed": int(outcome == Outcome.EVALUATED),
            "sessions_failed": 0, "sessions_skipped": int(outcome != Outcome.EVALUATED), "estimated_cost_usd": cost,
            "actual_cost_usd": cost, "checkpoint": event.session_id, "created_at": now.isoformat(), "finished_at": now.isoformat(),
        })
        log.info("live event handled", extra={
            "event": "live_event", "event_id": event.event_id, "session_id": event.session_id, "outcome": outcome.value,
            "organization_id": event.organization_id, "workspace_id": event.workspace_id, "cost_usd": cost,
            "latency_ms": watch.ms if watch else None})
        return outcome
