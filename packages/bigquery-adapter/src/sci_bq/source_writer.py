"""Writes conversations into the canonical source tables (`sessions`, `messages`), idempotently.

* A session is ONE row, moved forward by a bounded MERGE (pruned by the `started_at` day, clustered by tenant and session): inserted the
  first time and updated only when the incoming `updated_at` is newer, so a replayed or reordered delivery cannot move it backwards.
* Messages are immutable: streaming inserts with a row id (organization|workspace|session|message) that BigQuery de-duplicates for a short
  window; the reader de-duplicates by message_id for anything older (see queries.messages_for_sessions).
A write that fails raises, so the push is not acknowledged and Pub/Sub delivers it again.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sci_bq.source import Tenant
from sci_bq.tables import Tables

MAX_BYTES_BILLED = 200 * 1024 * 1024  # a bounded MERGE reads a few MB; this only stops a mistake from scanning a table


class SourceWriteError(RuntimeError):
    """BigQuery refused or failed a write (never contains message text)."""


def merge_session_sql(t: Tables) -> str:
    # `DATE(T.started_at) = @day` is what prunes the partition: started_at never changes for a session, so the match is exact.
    cols = "organization_id, workspace_id, session_id, channel, customer_id, seller_id, status, started_at, updated_at, closed_at, metadata"
    return (
        f"MERGE {t.sessions} T "
        "USING (SELECT @organization_id AS organization_id, @workspace_id AS workspace_id, @session_id AS session_id, "
        "@channel AS channel, @customer_id AS customer_id, @seller_id AS seller_id, @status AS status, @started_at AS started_at, "
        "@updated_at AS updated_at, @closed_at AS closed_at, PARSE_JSON(@metadata) AS metadata) S "
        "ON T.organization_id = S.organization_id AND T.workspace_id = S.workspace_id AND T.session_id = S.session_id "
        "AND DATE(T.started_at) = @day "
        "WHEN MATCHED AND S.updated_at > T.updated_at THEN UPDATE SET channel = S.channel, customer_id = S.customer_id, "
        "seller_id = S.seller_id, status = S.status, updated_at = S.updated_at, closed_at = S.closed_at, metadata = S.metadata "
        f"WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({', '.join('S.' + c.strip() for c in cols.split(','))})"
    )


def message_row_id(tenant: Tenant, session_id: str, message_id: str) -> str:
    return f"{tenant.organization_id}|{tenant.workspace_id}|{session_id}|{message_id}"


class BigQuerySourceWriter:
    def __init__(self, tables: Tables, location: str, client: Any | None = None) -> None:
        from google.cloud import bigquery

        self._bq = bigquery
        self._client = client or bigquery.Client(project=tables.project, location=location)
        self._t = tables

    def _params(self, tenant: Tenant, s: dict[str, Any]) -> list[Any]:
        bq = self._bq

        def ts(v: str | None) -> Any:
            return datetime.fromisoformat(v) if v else None

        started = ts(s["started_at"])
        assert started is not None
        return [
            bq.ScalarQueryParameter("organization_id", "STRING", tenant.organization_id),
            bq.ScalarQueryParameter("workspace_id", "STRING", tenant.workspace_id),
            bq.ScalarQueryParameter("session_id", "STRING", s["session_id"]),
            bq.ScalarQueryParameter("channel", "STRING", s.get("channel")),
            bq.ScalarQueryParameter("customer_id", "STRING", s.get("customer_id")),
            bq.ScalarQueryParameter("seller_id", "STRING", s.get("seller_id")),
            bq.ScalarQueryParameter("status", "STRING", s.get("status")),
            bq.ScalarQueryParameter("started_at", "TIMESTAMP", started),
            bq.ScalarQueryParameter("updated_at", "TIMESTAMP", ts(s["updated_at"])),
            bq.ScalarQueryParameter("closed_at", "TIMESTAMP", ts(s.get("closed_at"))),
            bq.ScalarQueryParameter("metadata", "STRING", json.dumps(s["metadata"]) if s.get("metadata") is not None else None),
            bq.ScalarQueryParameter("day", "DATE", started.astimezone(UTC).date()),
        ]

    async def upsert_session(self, tenant: Tenant, session: dict[str, Any]) -> bool:
        def run() -> bool:
            cfg = self._bq.QueryJobConfig(query_parameters=self._params(tenant, session), maximum_bytes_billed=MAX_BYTES_BILLED)
            job = self._client.query(merge_session_sql(self._t), job_config=cfg)
            job.result()
            return bool(job.num_dml_affected_rows)

        try:
            return await asyncio.to_thread(run)
        except Exception as exc:
            raise SourceWriteError(f"session merge failed: {type(exc).__name__}") from exc

    async def write_messages(self, tenant: Tenant, session_id: str, messages: Sequence[dict[str, Any]]) -> None:
        if not messages:
            return
        rows = [{**m, "metadata": json.dumps(m["metadata"]) if m.get("metadata") is not None else None} for m in messages]
        ids = [message_row_id(tenant, session_id, m["message_id"]) for m in messages]

        def run() -> list[Any]:
            return list(self._client.insert_rows_json(self._t.messages.strip("`"), rows, row_ids=ids))

        try:
            errors = await asyncio.to_thread(run)
        except Exception as exc:
            raise SourceWriteError(f"message insert failed: {type(exc).__name__}") from exc
        if errors:  # per-row errors carry only reasons and locations, never the row content
            reasons = sorted({str(e.get("errors", [{}])[0].get("reason", "unknown")) for e in errors if isinstance(e, dict)})
            raise SourceWriteError(f"message insert rejected: {', '.join(reasons)}")
