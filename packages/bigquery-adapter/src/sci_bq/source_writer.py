"""Writes conversations into the canonical source tables (`sessions`, `messages`), idempotently and without any UPDATE or MERGE.

* A session is stored as VERSIONS: each event that brings something newer appends a row, and a reader takes the latest one per session (see
  queries.current_sessions). Nothing is updated, so two events of the same conversation that arrive at the same moment cannot disagree about
  one row (a MERGE did: both saw "no row yet" and both inserted it). An event that is not newer than what is stored (a replay, an older
  delivery, a repeat) writes nothing, so a delivery out of order can never move a session backwards.
* Messages are immutable. Before inserting, the ids already stored for the session are looked up (one small query, pruned by the days of the
  incoming messages) and only the missing ones are inserted, so a resent message does not add a row. Streaming inserts also carry a row id
  that BigQuery de-duplicates for about a minute, which covers two deliveries racing each other; the reader still counts each message_id
  once (see queries.messages_for_sessions) as the last safety net.
A write that fails raises, so the push is not acknowledged and Pub/Sub delivers it again.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from sci_bq.source import Tenant
from sci_bq.tables import Tables

MAX_BYTES_BILLED = 200 * 1024 * 1024  # a lookup reads a few KB; this only stops a mistake from scanning a table


class SourceWriteError(RuntimeError):
    """BigQuery refused or failed a write (never contains message text)."""


def latest_session_sql(t: Tables) -> str:
    """The latest stored version of a session, if any. Tenant-scoped; `DATE(started_at) = @day` prunes the partition (started_at never
    changes for a session) and the clustering by tenant and session keeps the read to a few KB."""
    return (
        f"SELECT updated_at, status, closed_at FROM {t.sessions} WHERE organization_id = @organization_id AND workspace_id = @workspace_id "
        "AND session_id = @session_id AND DATE(started_at) = @day ORDER BY updated_at DESC, closed_at DESC LIMIT 1"
    )


def is_already_stored(latest: Mapping[str, Any] | None, updated_at: datetime, status: str | None, closed_at: datetime | None) -> bool:
    """True when this event adds nothing: a newer version exists, or the very same one. The same `updated_at` with another status or closing
    IS new (a session closed at the moment of its last message), and the reader prefers the closed row on a tie."""
    if latest is None:
        return False
    stored = latest["updated_at"]
    return bool(stored > updated_at or (stored == updated_at and latest.get("status") == status and latest.get("closed_at") == closed_at))


def session_row_id(tenant: Tenant, s: Mapping[str, Any]) -> str:
    """The same version delivered twice at once carries the same id, which BigQuery de-duplicates for about a minute."""
    return f"{tenant.organization_id}|{tenant.workspace_id}|{s['session_id']}|{s['updated_at']}|{s.get('status')}|{s.get('closed_at')}"


def stored_message_ids_sql(t: Tables) -> str:
    """The ids of the given messages that are already stored for a session. Tenant-scoped; the created_at days bound the partitions read."""
    return (
        f"SELECT DISTINCT message_id FROM {t.messages} WHERE organization_id = @organization_id AND workspace_id = @workspace_id "
        "AND session_id = @session_id AND DATE(created_at) BETWEEN @first_day AND @last_day AND message_id IN UNNEST(@message_ids)"
    )


def message_row_id(tenant: Tenant, session_id: str, message_id: str) -> str:
    return f"{tenant.organization_id}|{tenant.workspace_id}|{session_id}|{message_id}"


class BigQuerySourceWriter:
    def __init__(self, tables: Tables, location: str, client: Any | None = None) -> None:
        from google.cloud import bigquery

        self._bq = bigquery
        self._client = client or bigquery.Client(project=tables.project, location=location)
        self._t = tables

    async def _latest_version(self, tenant: Tenant, session: dict[str, Any]) -> Mapping[str, Any] | None:
        bq = self._bq
        started = datetime.fromisoformat(session["started_at"])

        def run() -> Mapping[str, Any] | None:
            cfg = bq.QueryJobConfig(
                query_parameters=[
                    bq.ScalarQueryParameter("organization_id", "STRING", tenant.organization_id),
                    bq.ScalarQueryParameter("workspace_id", "STRING", tenant.workspace_id),
                    bq.ScalarQueryParameter("session_id", "STRING", session["session_id"]),
                    bq.ScalarQueryParameter("day", "DATE", started.astimezone(UTC).date()),
                ],
                maximum_bytes_billed=MAX_BYTES_BILLED,
            )
            rows = list(self._client.query(latest_session_sql(self._t), job_config=cfg).result())
            return dict(rows[0]) if rows else None

        return await asyncio.to_thread(run)

    async def write_session(self, tenant: Tenant, session: dict[str, Any]) -> bool:
        """Appends a version of the session unless this event adds nothing. True when a row was written."""
        try:
            latest = await self._latest_version(tenant, session)
            updated = datetime.fromisoformat(session["updated_at"])
            closed = datetime.fromisoformat(session["closed_at"]) if session.get("closed_at") else None
            if is_already_stored(latest, updated, session.get("status"), closed):
                return False
            row = {
                "organization_id": tenant.organization_id, "workspace_id": tenant.workspace_id, **session,
                "metadata": json.dumps(session["metadata"]) if session.get("metadata") is not None else None,
            }

            def run() -> list[Any]:
                return list(self._client.insert_rows_json(self._t.sessions.strip("`"), [row], row_ids=[session_row_id(tenant, session)]))

            errors = await asyncio.to_thread(run)
        except Exception as exc:
            raise SourceWriteError(f"session write failed: {type(exc).__name__}") from exc
        if errors:  # per-row errors carry only reasons and locations, never the row content
            reasons = sorted({str(e.get("errors", [{}])[0].get("reason", "unknown")) for e in errors if isinstance(e, dict)})
            raise SourceWriteError(f"session write rejected: {', '.join(reasons)}")
        return True

    async def _stored_ids(self, tenant: Tenant, session_id: str, messages: Sequence[dict[str, Any]]) -> set[str]:
        days = sorted(datetime.fromisoformat(m["created_at"]).astimezone(UTC).date() for m in messages)
        bq = self._bq

        def run() -> set[str]:
            cfg = bq.QueryJobConfig(
                query_parameters=[
                    bq.ScalarQueryParameter("organization_id", "STRING", tenant.organization_id),
                    bq.ScalarQueryParameter("workspace_id", "STRING", tenant.workspace_id),
                    bq.ScalarQueryParameter("session_id", "STRING", session_id),
                    bq.ScalarQueryParameter("first_day", "DATE", days[0]),
                    bq.ScalarQueryParameter("last_day", "DATE", days[-1]),
                    bq.ArrayQueryParameter("message_ids", "STRING", [m["message_id"] for m in messages]),
                ],
                maximum_bytes_billed=MAX_BYTES_BILLED,
            )
            return {str(r["message_id"]) for r in self._client.query(stored_message_ids_sql(self._t), job_config=cfg).result()}

        try:
            return await asyncio.to_thread(run)
        except Exception as exc:
            raise SourceWriteError(f"message lookup failed: {type(exc).__name__}") from exc

    async def write_messages(self, tenant: Tenant, session_id: str, messages: Sequence[dict[str, Any]]) -> None:
        if not messages:
            return
        known = await self._stored_ids(tenant, session_id, messages)
        messages = [m for m in messages if m["message_id"] not in known]
        if not messages:
            return  # everything was stored by an earlier delivery
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
