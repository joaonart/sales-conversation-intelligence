"""Tenant spend and per-session rate lookups (bounded, parameterised)."""
from __future__ import annotations

from datetime import date, datetime

from sci_bq import queries
from sci_bq.runner import QueryRunner
from sci_bq.source import Tenant
from sci_bq.tables import Tables


class BigQueryLedger:
    def __init__(self, runner: QueryRunner, tables: Tables) -> None:
        self._runner, self._t = runner, tables

    async def month_to_date_usd(self, tenant: Tenant, month_start: date) -> float:
        rows = await self._runner.query(queries.month_to_date_spend(self._t), {**tenant.params(), "month_start": month_start})
        return float(rows[0]["spent_usd"]) if rows else 0.0

    async def analyses_since(
        self, tenant: Tenant, rubric_id: str, version: int, session_id: str, since: datetime
    ) -> int:
        rows = await self._runner.query(
            queries.recent_analysis_count(self._t),
            {**tenant.params(), "session_id": session_id, "rubric_id": rubric_id, "version": version,
             "since_date": since.date(), "since_ts": since},
        )
        return int(rows[0]["n"]) if rows else 0
