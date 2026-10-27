"""Run the project's real BigQuery SQL against DuckDB (sqlglot transpiles the dialect).

Not a BigQuery emulator: it checks query *semantics* (tenant predicates, dedupe, aggregates) on sample data.
"""
import json
import re
from pathlib import Path
from typing import Any

import duckdb
import sqlglot

from tests.ddl_schema import SOURCE_FILES, TABLE_FILES, parse_tables

VIEWS = Path(__file__).parent.parent / "infra" / "terraform" / "modules" / "platform" / "views"
DUCK_TYPES = {"STRING": "VARCHAR", "INTEGER": "BIGINT", "FLOAT": "DOUBLE", "BOOLEAN": "BOOLEAN",
              "TIMESTAMP": "TIMESTAMPTZ", "NUMERIC": "DECIMAL(38,9)", "JSON": "VARCHAR"}
REF = re.compile(r"`[^`.]+\.[^`.]+\.([^`]+)`")


def to_duck(sql: str) -> str:
    return sqlglot.transpile(REF.sub(r"\1", sql), read="bigquery", write="duckdb")[0]


class DuckBQ:
    def __init__(self) -> None:
        self.con = duckdb.connect(":memory:")
        self.con.execute("SET TimeZone='UTC'")
        for name, spec in parse_tables({**SOURCE_FILES, **TABLE_FILES}).items():
            cols = ", ".join(
                f"{c['name']} {DUCK_TYPES[c['type']]}{'[]' if c['mode'] == 'REPEATED' else ''}" for c in spec["columns"])
            self.con.execute(f"CREATE TABLE {name} ({cols})")

    def insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        for r in rows:
            cols = list(r)
            self.con.execute(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                             [json.dumps(v) if isinstance(v, (dict, list)) and not _is_str_list(v) else v for v in r.values()])

    def create_views(self, project: str = "PROJECT", dataset: str = "conversation_analytics") -> None:
        latest = (VIEWS / "latest_session_analyses.sql").read_text()
        manifest = json.loads((VIEWS / "manifest.json").read_text())
        self._view("latest_session_analyses", latest, project, dataset)
        for name in [*manifest["tier1"], *manifest["tier2"]]:
            self._view(name, (VIEWS / f"{name}.sql").read_text(), project, dataset)

    def _view(self, name: str, body: str, project: str, dataset: str) -> None:
        body = body.replace("${project}", project).replace("${dataset}", dataset)
        self.con.execute(f"CREATE VIEW {name} AS {to_duck(body)}")

    def rows(self, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        duck = to_duck(sql)
        used = {p: v for p, v in (params or {}).items() if f"${p}" in duck}
        cur = self.con.execute(duck, used)
        names = [d[0] for d in cur.description]
        return [dict(zip(names, row, strict=True)) for row in cur.fetchall()]


def _is_str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


class DuckRunner:
    """QueryRunner implementation backed by DuckBQ."""

    def __init__(self, db: DuckBQ) -> None:
        self.db, self.queries = db, []

    async def query(self, sql: str, params: Any, **kw: Any) -> list[dict[str, Any]]:
        self.queries.append((sql, dict(params)))
        return self.db.rows(sql, dict(params))

    async def dry_run(self, sql: str, params: Any) -> int:
        return 0
