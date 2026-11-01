"""Stores the AI spend rows (see sci_core.spend) as they happen, one streaming insert per paid call."""
from __future__ import annotations

import asyncio
from typing import Any

from sci_bq.tables import Tables


class SpendRecordError(RuntimeError):
    """BigQuery refused or failed to store a spend row (never contains the row)."""


class BigQuerySpendRecorder:
    def __init__(self, tables: Tables, location: str, client: Any | None = None) -> None:
        from google.cloud import bigquery

        self._client = client or bigquery.Client(project=tables.project, location=location)
        self._table = tables.ai_spend.strip("`")

    async def record(self, row: dict[str, Any]) -> None:
        def run() -> list[Any]:
            # A streaming insert is visible to queries at once (the cap reads it) and has no per-table daily limit; the row id makes a
            # retry of the SAME write a no-op without hiding a second paid call (its spend_id is different).
            return list(self._client.insert_rows_json(self._table, [row], row_ids=[row["spend_id"]]))

        try:
            errors = await asyncio.to_thread(run)
        except Exception as exc:
            raise SpendRecordError(f"spend insert failed: {type(exc).__name__}") from exc
        if errors:
            reasons = sorted({str(e.get("errors", [{}])[0].get("reason", "unknown")) for e in errors if isinstance(e, dict)})
            raise SpendRecordError(f"spend insert rejected: {', '.join(reasons)}")
