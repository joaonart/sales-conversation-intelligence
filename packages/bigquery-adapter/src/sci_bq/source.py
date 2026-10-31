"""BigQuery conversation source: tenant-scoped, partition-bounded, grouped reads."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sci_bq import queries
from sci_bq.runner import QueryRunner
from sci_bq.tables import Tables

MAX_PAGE_SIZE = 5000
MAX_WINDOW_DAYS = 366


@dataclass(frozen=True)
class Cursor:
    """Stable keyset checkpoint: (updated_at, session_id)."""
    updated_at: datetime
    session_id: str = ""


@dataclass(frozen=True)
class SessionPage:
    sessions: list[dict[str, Any]]
    next_cursor: Cursor | None  # None -> exhausted


@dataclass(frozen=True)
class Tenant:
    organization_id: str
    workspace_id: str

    def __post_init__(self) -> None:
        if not self.organization_id or not self.workspace_id:
            raise ValueError("organization_id and workspace_id are required")

    def params(self) -> dict[str, str]:
        return {"organization_id": self.organization_id, "workspace_id": self.workspace_id}


def _check_window(start: date, end: date) -> None:
    if end < start:
        raise ValueError("end_date before start_date")
    if (end - start).days > MAX_WINDOW_DAYS:
        raise ValueError(f"date window exceeds {MAX_WINDOW_DAYS} days; split the job")


class BigQuerySource:
    def __init__(self, runner: QueryRunner, tables: Tables, *, max_bytes_billed: int | None = None) -> None:
        self._runner, self._t = runner, tables
        self._cap = {"max_bytes_billed": max_bytes_billed} if max_bytes_billed else {}

    async def list_sessions(
        self, tenant: Tenant, *, start_date: date, end_date: date, cursor: Cursor,
        page_size: int = 500, status: str | None = None, routed_to: tuple[str, int] | None = None,
        only_session: str | None = None,
    ) -> SessionPage:
        _check_window(start_date, end_date)
        if not 0 < page_size <= MAX_PAGE_SIZE:
            raise ValueError(f"page_size must be within 1..{MAX_PAGE_SIZE}")
        params: dict[str, Any] = {
            **tenant.params(), "start_date": start_date, "end_date": end_date,
            "cursor_updated_at": cursor.updated_at, "cursor_session_id": cursor.session_id, "page_size": page_size,
        }
        if status:
            params["status"] = status
        if only_session:
            params["only_session"] = only_session
        if routed_to:
            params["route_rubric"], params["route_version"] = routed_to
        rows = await self._runner.query(
            queries.session_page(self._t, only_status=bool(status), only_routed=routed_to is not None, only_session=bool(only_session)),
            params, **self._cap)
        nxt = Cursor(rows[-1]["updated_at"], rows[-1]["session_id"]) if len(rows) == page_size else None
        return SessionPage(rows, nxt)

    async def get_session(
        self, tenant: Tenant, session_id: str, *, lookback_days: int = 90, today: date | None = None
    ) -> dict[str, Any] | None:
        since = (today or date.today()) - timedelta(days=lookback_days)
        rows = await self._runner.query(
            queries.session_by_id(self._t), {**tenant.params(), "session_id": session_id, "since_date": since}, **self._cap
        )
        return rows[0] if rows else None

    async def get_messages(
        self, tenant: Tenant, session_ids: list[str], *, start_date: date, end_date: date
    ) -> dict[str, list[dict[str, Any]]]:
        """Messages grouped by session. Sessions without messages map to []."""
        _check_window(start_date, end_date)
        if not session_ids:
            return {}
        rows = await self._runner.query(
            queries.messages_for_sessions(self._t),
            {**tenant.params(), "session_ids": list(dict.fromkeys(session_ids)), "start_date": start_date, "end_date": end_date},
            **self._cap,
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in rows:
            grouped[r["session_id"]].append(r)
        return {sid: grouped.get(sid, []) for sid in session_ids}
