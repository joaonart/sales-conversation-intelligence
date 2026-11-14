"""Clear the AUDIT TRAIL (`conversation_config.audit_log`) of ONE test workspace: its Auditoria page starts empty.

It is a separate process from `clean_workspace.py` on purpose: that one deletes conversations and results and never touches the trail,
so cleaning data does not erase the evidence by accident; clearing the trail is a decision of its own, made here.

What is deleted (only rows of the given organization AND workspace, optionally only those before a day): the audit events.
What is written afterwards: one event, `audit.clean` (actor `script:clean_audit`, with how many rows were removed and the cut-off day),
so the trail always says that it was cleared and when. Nothing else is touched (conversations, rubrics, users, ledger, schedules).

Safety:
- Dry run by default: it prints how many events there are (oldest and newest) and what it would delete. Nothing changes without --apply.
- Only a test workspace: the organization must start with `synthetic-` or be `org-test`. There is no flag to clear the trail of
  any other organization: the evidence of a real tenant is not erased by this script.
- The delete carries `organization_id = ... AND workspace_id = ...` as bound parameters: no other tenant or workspace is touched.
- BigQuery time travel can bring the rows back for 48 hours on the platform datasets.

    python scripts/clean_audit.py --project P --org org-test --workspace default                       # dry run
    python scripts/clean_audit.py --project P --org org-test --workspace default --apply               # delete all of its trail
    python scripts/clean_audit.py --project P --org org-test --workspace default --before 2026-11-01 --apply   # only before that day
"""

from __future__ import annotations

import argparse
import json
import re
import uuid
from typing import Any

TEST_ORG_PREFIX, TEST_ORGS = "synthetic-", {"org-test"}
DATASET, TABLE = "conversation_config", "audit_log"
TENANT = "organization_id = @org AND workspace_id = @ws"
TRACE_ACTOR = "script:clean_audit"
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def is_test_org(org: str) -> bool:
    return org.startswith(TEST_ORG_PREFIX) or org in TEST_ORGS


def check_args(org: str, workspace: str, before: str | None) -> None:
    if not org or not workspace or any(c in org + workspace for c in "'\"`; "):
        raise SystemExit("invalid organization or workspace")
    if not is_test_org(org):
        raise SystemExit(f"'{org}' is not a test organization (synthetic-* or org-test): this script never clears the trail of any other.")
    if before is not None and not DAY.match(before):
        raise SystemExit("--before must be a day as YYYY-MM-DD")


def _ref(project: str) -> str:
    return f"`{project}.{DATASET}.{TABLE}`"


def scope(before: str | None) -> str:
    return TENANT + (" AND occurred_at < TIMESTAMP(@before)" if before else "")


def count_sql(project: str, before: str | None) -> str:
    return f"SELECT COUNT(*) AS n, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM {_ref(project)} WHERE {scope(before)}"


def delete_sql(project: str, before: str | None) -> str:
    return f"DELETE FROM {_ref(project)} WHERE {scope(before)}"


def trace_sql(project: str) -> str:
    return (
        f"INSERT INTO {_ref(project)} (event_id, occurred_at, actor_email, organization_id, workspace_id, action, entity_type, "
        "entity_id, outcome, details, request_id) "
        f"VALUES (@event_id, CURRENT_TIMESTAMP(), '{TRACE_ACTOR}', @org, @ws, 'audit.clean', 'audit_log', @ws, 'SUCCESS', "
        "PARSE_JSON(@details), NULL)"
    )


def run(client: Any, project: str, org: str, workspace: str, *, apply: bool, before: str | None = None, out: Any = print) -> int:
    """0 = done (or a dry run), 1 = stopped by an error before finishing. `client` is a google.cloud.bigquery.Client."""
    from google.cloud import bigquery

    def params(extra: list[Any] | None = None) -> Any:
        p = [bigquery.ScalarQueryParameter("org", "STRING", org), bigquery.ScalarQueryParameter("ws", "STRING", workspace)]
        if before:
            p.append(bigquery.ScalarQueryParameter("before", "STRING", before))
        return bigquery.QueryJobConfig(query_parameters=p + (extra or []))

    def count() -> tuple[int, Any, Any]:
        row = list(client.query(count_sql(project, before), job_config=params()).result())[0]
        return int(row["n"]), row["oldest"], row["newest"]

    n, oldest, newest = count()
    window = f" before {before}" if before else ""
    out(f"Audit trail of {org}/{workspace}: {n} event(s){window}" + (f" (oldest {oldest}, newest {newest})" if n else ""))
    if not apply:
        out(f"  would delete  {DATASET}.{TABLE:<12} {n:>6} row(s); then record 'audit.clean'")
        out("Dry run: nothing was changed (add --apply to delete).")
        return 0
    try:
        if n:
            client.query(delete_sql(project, before), job_config=params()).result()
        left, _, _ = count()  # counted before the trace is written, so the trace is not taken for a row that stayed
        if left:
            out(f"Events left{window}: {left}. Nothing was recorded.")
            return 1
        trace = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("event_id", "STRING", str(uuid.uuid4())),
                bigquery.ScalarQueryParameter("org", "STRING", org),
                bigquery.ScalarQueryParameter("ws", "STRING", workspace),
                bigquery.ScalarQueryParameter("details", "STRING", json.dumps({"rows_removed": n, "before": before})),
            ]
        )
        client.query(trace_sql(project), job_config=trace).result()
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        hint = " The rows are still in a streaming buffer (about 90 minutes): run it again later." if "streaming buffer" in text else ""
        out(f"STOPPED: {type(exc).__name__}.{hint}")
        return 1
    out(f"  deleted       {DATASET}.{TABLE} ({n} row(s)); recorded 'audit.clean' as the trace")
    out(f"Done. Events left{window}: 0 (plus the record of this clean).")
    return 0


def main() -> None:  # pragma: no cover - needs real GCP
    from google.cloud import bigquery

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--project", required=True)
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--before", help="only events before this day (YYYY-MM-DD); by default all of the workspace's trail")
    p.add_argument("--apply", action="store_true", help="really delete (the default only shows what would be deleted)")
    a = p.parse_args()
    check_args(a.org, a.workspace, a.before)
    raise SystemExit(run(bigquery.Client(project=a.project, location="US"), a.project, a.org, a.workspace, apply=a.apply, before=a.before))


if __name__ == "__main__":
    main()
