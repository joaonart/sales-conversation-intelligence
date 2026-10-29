"""Remove the synthetic seed data (tenants prefixed `synthetic-`) from BigQuery, without reloading it.

`seed_synthetic.py --reset` deletes AND reloads; this only deletes, to start an end-to-end validation from an empty platform.

Safety:
- Dry run by default: prints what would be deleted. Nothing changes without --apply.
- Every statement is filtered by `STARTS_WITH(organization_id, 'synthetic-')`: rows of any other tenant are never touched
  (the counts show them).
- `app_users` (who can use the console) and `audit_log` (who did what) are NEVER touched: deleting them would lock people out
  and erase the evidence trail.
- BigQuery time travel can bring deleted rows back for a while (48 h on the platform datasets), and `seed_synthetic.py`
  regenerates the same data deterministically.

    python scripts/clean_synthetic.py --project jnart-intelligence-513001            # dry run
    python scripts/clean_synthetic.py --project jnart-intelligence-513001 --apply    # delete
"""

from __future__ import annotations

import argparse

PREFIX = "synthetic-"
# (dataset, table). BigQuery has no foreign keys, but derived tables go first so a partial failure
# never leaves results without their source.
TABLES: list[tuple[str, str]] = [
    ("conversation_config", "review_decisions"),
    ("conversation_analytics", "session_criterion_results"),
    ("conversation_analytics", "session_analyses"),
    ("conversation_analytics", "analysis_runs"),
    ("conversation_config", "evaluation_criteria"),
    ("conversation_config", "evaluation_policies"),
    ("conversation_config", "evaluation_rubrics"),
    ("commerce", "messages"),
    ("commerce", "sessions"),
]
# Never cleaned, whatever the tenant.
PROTECTED = {"app_users", "audit_log"}


def _ref(project: str, dataset: str, table: str) -> str:
    return f"`{project}.{dataset}.{table}`"


def count_statements(project: str) -> list[tuple[str, str, str]]:
    """(table label, SQL counting the synthetic rows, SQL counting everything else)."""
    out = []
    for dataset, table in TABLES:
        ref = _ref(project, dataset, table)
        out.append((f"{dataset}.{table}",
                    f"SELECT COUNT(*) AS n FROM {ref} WHERE STARTS_WITH(organization_id, '{PREFIX}')",
                    f"SELECT COUNT(*) AS n FROM {ref} WHERE NOT STARTS_WITH(organization_id, '{PREFIX}')"))
    return out


def delete_statements(project: str) -> list[tuple[str, str]]:
    where = f"WHERE STARTS_WITH(organization_id, '{PREFIX}')"
    return [(f"{dataset}.{table}", f"DELETE FROM {_ref(project, dataset, table)} {where}") for dataset, table in TABLES]


def main() -> None:  # pragma: no cover - needs real GCP
    from google.cloud import bigquery

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="US")
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    a = ap.parse_args()
    client = bigquery.Client(project=a.project, location=a.location)

    def n(sql: str) -> int:
        return int(next(iter(client.query(sql).result())).n)

    print(f"{'table':50} {'synthetic':>10} {'other tenants':>14}")
    total = 0
    for label, syn_sql, other_sql in count_statements(a.project):
        syn, other = n(syn_sql), n(other_sql)
        total += syn
        print(f"{label:50} {syn:>10} {other:>14}")
    print(f"kept untouched: {', '.join(sorted(PROTECTED))}")
    if not a.apply:
        print(f"\ndry run: {total} synthetic rows would be deleted. Re-run with --apply to delete them.")
        return
    for label, sql in delete_statements(a.project):
        job = client.query(sql)
        job.result()
        print(f"deleted {job.num_dml_affected_rows or 0:>6} rows from {label}")
    left = sum(n(syn_sql) for _, syn_sql, _ in count_statements(a.project))
    print(f"\ndone: {left} synthetic rows left")


if __name__ == "__main__":
    main()
