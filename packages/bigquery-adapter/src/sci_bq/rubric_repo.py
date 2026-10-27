"""BigQuery-backed RubricRepository."""
from __future__ import annotations

from sci_bq import queries
from sci_bq.runner import Param, QueryRunner
from sci_bq.tables import Tables
from sci_core.rubric import Rubric


class BigQueryRubricRepository:
    def __init__(self, runner: QueryRunner, tables: Tables) -> None:
        self._runner, self._t = runner, tables

    async def fetch(self, organization_id: str, workspace_id: str, rubric_id: str, version: int | None) -> Rubric | None:
        base: dict[str, Param] = {"organization_id": organization_id, "workspace_id": workspace_id, "rubric_id": rubric_id}
        header_params: dict[str, Param] = {**base, **({"version": version} if version is not None else {})}
        headers = await self._runner.query(queries.rubric_header(self._t, pinned=version is not None), header_params)
        if not headers:
            return None
        resolved: dict[str, Param] = {**base, "version": int(headers[0]["version"])}
        criteria = await self._runner.query(queries.rubric_criteria(self._t), resolved)
        policy = await self._runner.query(queries.rubric_policy(self._t), resolved)
        return Rubric.from_rows(headers[0], criteria, policy[0] if policy else None)
