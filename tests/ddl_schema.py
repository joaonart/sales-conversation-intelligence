"""Extract BigQuery column specs from the DDL in sql/ (single source of truth for table schemas)."""
from pathlib import Path

import sqlglot
from sqlglot import exp

SQL_DIR = Path(__file__).parent.parent / "sql"
TABLE_FILES = {"01_config.sql": "conversation_config", "02_analytics.sql": "conversation_analytics"}
SOURCE_FILES = {"00_source_canonical.sql": "commerce"}


# GoogleSQL names -> canonical names used by the BigQuery tables API (avoids spurious Terraform diffs)
API_TYPES = {"INT64": "INTEGER", "FLOAT64": "FLOAT", "BOOL": "BOOLEAN"}


def _api_type(t: str) -> str:
    return API_TYPES.get(t, t)


def parse_tables(files: dict[str, str] | None = None) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for fname in files or TABLE_FILES:
        sql = (SQL_DIR / fname).read_text()
        for stmt in sqlglot.parse(sql, read="bigquery"):
            if not isinstance(stmt, exp.Create) or stmt.args.get("kind") != "TABLE":
                continue
            schema = stmt.this
            cols = []
            for cd in schema.expressions:
                if not isinstance(cd, exp.ColumnDef):
                    continue
                kind = cd.args["kind"]
                required = any(isinstance(c.kind, exp.NotNullColumnConstraint) for c in cd.args.get("constraints", []))
                if kind.this == exp.DataType.Type.ARRAY:
                    ctype, mode = _api_type(kind.expressions[0].sql("bigquery")), "REPEATED"
                else:
                    ctype, mode = _api_type(kind.sql("bigquery")), "REQUIRED" if required else "NULLABLE"
                cols.append({"name": cd.name, "type": ctype, "mode": mode})
            part = stmt.find(exp.PartitionedByProperty)
            clus = stmt.find(exp.ClusterProperty)
            out[schema.this.name] = {
                "columns": cols,
                "partition_field": part.this.find(exp.Column).name if part else None,
                "cluster": [c.name for c in clus.expressions] if clus else [],
            }
    return out
