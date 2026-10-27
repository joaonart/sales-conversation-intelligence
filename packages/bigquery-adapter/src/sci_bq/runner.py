"""Query execution with mandatory cost caps. Production code never runs unbounded queries."""
from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any, Protocol

DEFAULT_MAX_BYTES_BILLED = 1 * 1024**3  # 1 GiB; callers raise it explicitly per approved job

Param = str | int | float | bool | date | datetime | Sequence[str] | None


class QueryTooExpensive(RuntimeError):
    pass


class QueryRunner(Protocol):
    async def query(
        self, sql: str, params: Mapping[str, Param], *, max_bytes_billed: int = DEFAULT_MAX_BYTES_BILLED
    ) -> list[dict[str, Any]]: ...

    async def dry_run(self, sql: str, params: Mapping[str, Param]) -> int:
        """Estimated bytes processed; no cost incurred."""
        ...


def to_query_parameter(name: str, value: Param) -> Any:
    from google.cloud import bigquery

    if isinstance(value, (list, tuple)):
        return bigquery.ArrayQueryParameter(name, "STRING", list(value))
    if isinstance(value, bool):  # before int: bool is an int subclass
        return bigquery.ScalarQueryParameter(name, "BOOL", value)
    if isinstance(value, int):
        return bigquery.ScalarQueryParameter(name, "INT64", value)
    if isinstance(value, float):
        return bigquery.ScalarQueryParameter(name, "FLOAT64", value)
    if isinstance(value, datetime):
        return bigquery.ScalarQueryParameter(name, "TIMESTAMP", value)
    if isinstance(value, date):
        return bigquery.ScalarQueryParameter(name, "DATE", value)
    return bigquery.ScalarQueryParameter(name, "STRING", None if value is None else str(value))


class BigQueryRunner:
    """google-cloud-bigquery implementation (sync client run in a worker thread)."""

    def __init__(self, project: str, location: str, client: Any | None = None) -> None:
        from google.cloud import bigquery

        self._bq = bigquery
        self._client = client or bigquery.Client(project=project, location=location)

    def _config(self, params: Mapping[str, Param], **kw: Any) -> Any:
        return self._bq.QueryJobConfig(
            query_parameters=[to_query_parameter(k, v) for k, v in params.items()], use_query_cache=True, **kw
        )

    async def dry_run(self, sql: str, params: Mapping[str, Param]) -> int:
        def run() -> int:
            job = self._client.query(sql, job_config=self._config(params, dry_run=True))
            return int(job.total_bytes_processed)

        return await asyncio.to_thread(run)

    async def query(
        self, sql: str, params: Mapping[str, Param], *, max_bytes_billed: int = DEFAULT_MAX_BYTES_BILLED
    ) -> list[dict[str, Any]]:
        estimated = await self.dry_run(sql, params)
        if estimated > max_bytes_billed:
            raise QueryTooExpensive(f"dry-run {estimated} bytes > cap {max_bytes_billed}")

        def run() -> list[dict[str, Any]]:
            # maximum_bytes_billed is enforced server-side as a second line of defence.
            job = self._client.query(sql, job_config=self._config(params, maximum_bytes_billed=max_bytes_billed))
            return [dict(row) for row in job.result()]

        return await asyncio.to_thread(run)
