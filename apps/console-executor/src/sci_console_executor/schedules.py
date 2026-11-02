"""Recurring executions: a due schedule becomes an ordinary request of `run_requests`, which goes through every executor gate.

A schedule never runs or spends anything by itself. On each poll the executor asks which schedules are due and, for each one,
writes ONE request whose id is a hash of (workspace, schedule, slot): polling twice, or two executors polling at once, cannot
create it twice. The request is attributed to the administrator who created the schedule, so the executor still checks that this
person is an active ADMIN, applies the request's own cost ceiling and the executor's monthly budget, and the content-hash dedupe
makes each run pay only for the sessions that are new.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from sci_bq.runner import QueryRunner
from sci_bq.source import Tenant
from sci_console_executor.requests import MAX_WINDOW_DAYS, TENANT, _table
from sci_openai.catalog import UnknownModel, find

log = logging.getLogger("sci.console_executor.schedules")  # metadata only: never names, never content

MAX_ACTIVE_REQUESTS = 3  # the same limit the console applies to a workspace
SCHEDULER_ID = "scheduler"


class Schedule(BaseModel):
    """One ACTIVE schedule as stored (latest row). The table is data, not authority: it is validated again here."""

    model_config = ConfigDict(extra="forbid", frozen=True, arbitrary_types_allowed=True)

    schedule_id: str = Field(min_length=1, max_length=64)
    tenant: Tenant
    name: str = Field(min_length=1, max_length=80)
    frequency: Literal["DAILY", "WEEKLY"]
    hour_utc: int = Field(ge=0, le=23)
    minute_utc: int = Field(ge=0, le=59)
    weekday: int | None = Field(default=None, ge=0, le=6)  # 0 = Monday
    rubric_id: str = Field(min_length=1, max_length=128)
    rubric_version: int = Field(ge=1)
    window_days: int = Field(ge=1, le=MAX_WINDOW_DAYS)
    max_sessions: int = Field(ge=1)
    only_routed: bool
    provider: Literal["decisions", "responses"]
    model: str = Field(min_length=1, max_length=64)
    max_cost_usd: float = Field(gt=0)
    created_by: str = Field(min_length=3, max_length=254)
    effective_from: datetime  # the latest change: an edit, a pause or a resume counts from the NEXT slot

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Schedule:
        fields = ("schedule_id", "name", "frequency", "hour_utc", "minute_utc", "weekday", "rubric_id", "rubric_version", "window_days",
                  "max_sessions", "only_routed", "provider", "model", "max_cost_usd", "created_by")
        data = {k: row[k] for k in fields}
        data["tenant"] = Tenant(str(row["organization_id"]), str(row["workspace_id"]))
        data["effective_from"] = row["changed_at"]
        s = cls.model_validate(data)
        if (s.frequency == "WEEKLY") != (s.weekday is not None):
            raise ValueError("weekday is required for WEEKLY and forbidden for DAILY")
        find(s.provider, s.model)  # a closed list: a stored schedule cannot name any other model or price
        return s


def last_slot(s: Schedule, now: datetime) -> datetime:
    """The most recent moment, at or before `now`, at which the schedule was meant to run."""
    today = now.astimezone(UTC).replace(hour=s.hour_utc, minute=s.minute_utc, second=0, microsecond=0)
    if s.frequency == "DAILY":
        return today if today <= now else today - timedelta(days=1)
    slot = today - timedelta(days=(now.weekday() - (s.weekday or 0)) % 7)
    return slot if slot <= now else slot - timedelta(days=7)


def due_slot(s: Schedule, now: datetime) -> datetime | None:
    """The slot to run now, or None. Only the LAST slot is ever run (a stopped executor never replays a backlog), and never one that was
    already in the past when the schedule was created, edited or resumed."""
    slot = last_slot(s, now)
    return slot if slot > s.effective_from.astimezone(UTC) else None


def slot_request_id(s: Schedule, slot: datetime) -> str:
    key = f"{s.tenant.organization_id}|{s.tenant.workspace_id}|{s.schedule_id}|{slot.astimezone(UTC).isoformat()}"
    return "sched-" + hashlib.sha256(key.encode()).hexdigest()[:24]


def request_params(s: Schedule, slot: datetime) -> dict[str, Any]:
    end = slot.astimezone(UTC).date()
    return {
        "start": (end - timedelta(days=s.window_days)).isoformat(), "end": end.isoformat(), "max_sessions": s.max_sessions,
        "rubric_id": s.rubric_id, "rubric_version": s.rubric_version, "only_routed": s.only_routed,
        "provider": s.provider, "model": s.model, "schedule_id": s.schedule_id,
    }


class ScheduleStore(Protocol):
    async def schedules(self, tenant: Tenant) -> list[dict[str, Any]]: ...
    async def active_requests(self, tenant: Tenant) -> list[dict[str, Any]]: ...  # {request_id, schedule_id} of REQUESTED/RUNNING
    async def create_request(self, s: Schedule, request_id: str, params: dict[str, Any]) -> None: ...


@dataclass(frozen=True)
class Materialized:
    created: list[str]
    skipped: dict[str, str]  # schedule_id -> why nothing was created now


class ScheduleMaterializer:
    def __init__(self, store: ScheduleStore, clock: Any = lambda: datetime.now(UTC)) -> None:
        self._store, self._clock = store, clock

    async def run(self, tenants: Sequence[Tenant]) -> Materialized:
        now = self._clock()
        created: list[str] = []
        skipped: dict[str, str] = {}
        for tenant in tenants:
            active = await self._store.active_requests(tenant)
            for row in await self._store.schedules(tenant):
                sid = str(row.get("schedule_id"))
                try:
                    s = Schedule.from_row(row)
                except (ValueError, ValidationError, KeyError, TypeError, UnknownModel):
                    skipped[sid] = "invalid"
                    log.warning("schedule invalid", extra={"event": "schedule_invalid", "schedule_id": sid})
                    continue
                slot = due_slot(s, now)
                if slot is None:
                    continue
                rid = slot_request_id(s, slot)
                if any(a["request_id"] == rid for a in active):
                    continue  # already waiting or running
                if any(a.get("schedule_id") == s.schedule_id for a in active):
                    skipped[sid] = "previous_run_still_active"  # never two runs of the same schedule at once
                    continue
                if len(active) >= MAX_ACTIVE_REQUESTS:
                    skipped[sid] = "workspace_busy"  # the slot is still the last one on the next poll: it is retried
                    continue
                await self._store.create_request(s, rid, request_params(s, slot))
                active.append({"request_id": rid, "schedule_id": s.schedule_id})
                created.append(rid)
                log.info("schedule due", extra={"event": "schedule_due", "schedule_id": s.schedule_id, "request_id": rid})
        return Materialized(created, skipped)


_LATEST_SCHEDULE = "QUALIFY ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY changed_at DESC) = 1"


class BigQueryScheduleStore:
    """Reads the schedules and appends requests. Every statement is tenant-scoped; no other configuration table is written."""

    def __init__(self, runner: QueryRunner, project: str, config_dataset: str = "conversation_config") -> None:
        self._runner = runner
        self._sched = _table(project, config_dataset, "run_schedules")
        self._req = _table(project, config_dataset, "run_requests")

    async def schedules(self, tenant: Tenant) -> list[dict[str, Any]]:
        return await self._runner.query(
            "SELECT schedule_id, changed_at, organization_id, workspace_id, name, frequency, hour_utc, minute_utc, weekday, rubric_id, "
            "rubric_version, window_days, max_sessions, only_routed, provider, model, max_cost_usd, created_by "
            f"FROM {self._sched} WHERE {TENANT} {_LATEST_SCHEDULE} AND status = 'ACTIVE' ORDER BY schedule_id LIMIT 50",
            tenant.params(),
        )

    async def active_requests(self, tenant: Tenant) -> list[dict[str, Any]]:
        return await self._runner.query(
            "SELECT request_id, JSON_VALUE(params, '$.schedule_id') AS schedule_id "
            f"FROM {self._req} WHERE {TENANT} AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY) "
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY changed_at DESC) = 1 AND status IN ('REQUESTED', 'RUNNING')",
            tenant.params(),
        )

    async def create_request(self, s: Schedule, request_id: str, params: dict[str, Any]) -> None:
        """Guarded inside the statement: if the request already exists (another poll or executor wrote it) nothing is written."""
        await self._runner.query(
            f"INSERT INTO {self._req} (request_id, changed_at, organization_id, workspace_id, kind, status, params, max_cost_usd, "
            "estimate_low_usd, estimate_high_usd, requested_by, requested_at, changed_by, result, error) "
            "SELECT @request_id, CURRENT_TIMESTAMP(), @organization_id, @workspace_id, 'ANALYSIS', 'REQUESTED', PARSE_JSON(@params), "
            "@max_cost_usd, NULL, NULL, @requested_by, CURRENT_TIMESTAMP(), @changed_by, NULL, NULL "
            f"FROM (SELECT 1) WHERE NOT EXISTS (SELECT 1 FROM {self._req} WHERE {TENANT} AND request_id = @request_id "
            "AND DATE(requested_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY))",
            {**s.tenant.params(), "request_id": request_id, "params": json.dumps(params), "max_cost_usd": s.max_cost_usd,
             "requested_by": s.created_by, "changed_by": f"{SCHEDULER_ID}:{s.schedule_id}"},
        )
