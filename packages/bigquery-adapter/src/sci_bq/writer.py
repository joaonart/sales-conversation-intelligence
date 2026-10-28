"""Batched, append-only result writes using BigQuery load jobs (no per-row DML, no MERGE)."""
from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import date, timedelta
from typing import Any, Protocol

from google.api_core.exceptions import Conflict

from sci_bq import queries
from sci_bq.runner import QueryRunner
from sci_bq.source import Tenant
from sci_bq.tables import Tables
from sci_core.hashing import canonical_hash

JSON_COLUMNS = {"evaluation_result", "metadata"}


class ResultWriter(Protocol):
    async def write(self, analyses: Sequence[dict[str, Any]], criteria: Sequence[dict[str, Any]]) -> None: ...


def _serialise(row: dict[str, Any]) -> dict[str, Any]:
    # JSON-typed columns must be sent as native JSON values: verified on BigQuery that a Python str
    # (even one holding JSON text) is stored as a JSON *string* scalar, not as an object.
    return dict(row)


class BigQueryResultWriter:
    """Load jobs are free and atomic per job: a batch lands entirely or not at all."""

    def __init__(self, tables: Tables, location: str, client: Any | None = None) -> None:
        from google.cloud import bigquery

        self._bq = bigquery
        self._client = client or bigquery.Client(project=tables.project, location=location)
        self._t = tables

    def _load(self, table_ref: str, rows: Sequence[dict[str, Any]], job_id: str) -> None:
        if not rows:
            return
        cfg = self._bq.LoadJobConfig(
            write_disposition="WRITE_APPEND", source_format=self._bq.SourceFormat.NEWLINE_DELIMITED_JSON
        )
        # Deterministic job id makes a retried load a no-op instead of a duplicate append.
        try:
            job = self._client.load_table_from_json([_serialise(r) for r in rows], table_ref.strip("`"), job_config=cfg,
                                                    job_id=job_id)
            job.result()
        except Conflict:
            # BigQuery rejects a reused job id (observed: 409 Already Exists). That is a retry of a batch whose job
            # exists: accept it only if that job finished cleanly; a failed job must not be mistaken for success.
            existing = self._client.get_job(job_id)
            if existing.state != "DONE" or existing.error_result:
                raise

    async def write(self, analyses: Sequence[dict[str, Any]], criteria: Sequence[dict[str, Any]]) -> None:
        batch_key = canonical_hash(sorted(a["analysis_id"] for a in analyses))[:32]
        await asyncio.to_thread(self._load, self._t.analyses, analyses, f"sci-analyses-{batch_key}")
        await asyncio.to_thread(self._load, self._t.criterion_results, criteria, f"sci-criteria-{batch_key}")

    async def write_run(self, run: dict[str, Any]) -> None:
        job_id = f"sci-run-{canonical_hash([run['run_id'], run['created_at']])[:32]}"
        await asyncio.to_thread(self._load, self._t.runs, [run], job_id)


class BigQueryRunStore:
    """Checkpoint persistence in analysis_runs (append-only; latest row wins)."""

    def __init__(self, runner: QueryRunner, writer: BigQueryResultWriter, tables: Tables, *, lookback_days: int = 30) -> None:
        self._runner, self._writer, self._t, self._lookback = runner, writer, tables, lookback_days

    async def latest(self, tenant: Tenant, run_id: str, *, today: date | None = None) -> dict[str, Any] | None:
        since = (today or date.today()) - timedelta(days=self._lookback)
        rows = await self._runner.query(queries.latest_run(self._t), {**tenant.params(), "run_id": run_id, "since_date": since})
        return rows[0] if rows else None

    async def save(self, run: dict[str, Any]) -> None:
        await self._writer.write_run(run)

    async def existing(self, tenant: Tenant, rubric_id: str, version: int, session_ids: list[str], *, since: date) -> set[tuple[str, str]]:
        rows = await self._runner.query(
            queries.existing_analyses(self._t),
            {**tenant.params(), "rubric_id": rubric_id, "version": version, "session_ids": session_ids, "since_date": since},
        )
        return {(r["session_id"], r["session_content_hash"]) for r in rows}
