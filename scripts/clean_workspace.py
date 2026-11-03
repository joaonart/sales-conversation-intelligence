"""Remove the DATA of ONE workspace (its conversations and everything the platform produced from them), to start a test from an empty workspace.

What is deleted (only rows of the given organization AND workspace): the conversations (`commerce.sessions`, `messages`, `participants`) and their
results (`session_criterion_results`, `session_analyses`, `analysis_runs`, `session_routes`, `run_failures`, `review_decisions`).

What is NEVER touched, whatever the arguments:
- the rubrics (`evaluation_rubrics`, `evaluation_criteria`, `evaluation_policies`): published rubrics are immutable and the next test needs them;
- who can use the console (`app_users`) and the trail of who did what (`audit_log`): deleting them would lock people out and erase the evidence;
- the spend ledger (`ai_spend`): it is the financial record the monthly caps read;
- the requests and schedules made in the console (`run_requests`, `run_schedules`).

Safety:
- Dry run by default: it prints what it would delete and what it keeps. Nothing changes without --apply.
- Only a test workspace: the organization must start with `synthetic-` or be `org-test`, unless --allow-any-tenant is given on purpose.
- Every statement carries `organization_id = ... AND workspace_id = ...`: no other tenant is touched (the counts of what stays are printed).
- BigQuery time travel can bring the rows back for 48 hours on the platform datasets.
- Rows written by a streaming insert (the conversation messages) cannot be deleted for roughly the first 90 minutes: if that is the case it stops there
  and says so, instead of leaving the workspace half cleaned; run it again later.

    python scripts/clean_workspace.py --project P --org org-test --workspace default            # dry run
    python scripts/clean_workspace.py --project P --org org-test --workspace default --apply    # delete
"""

from __future__ import annotations

import argparse
from typing import Any

TEST_ORG_PREFIX, TEST_ORGS = "synthetic-", {"org-test"}
# Derived tables first, the conversations last: a partial failure never leaves results without their source.
DELETE: list[tuple[str, str]] = [
    ("conversation_config", "review_decisions"),
    ("conversation_analytics", "session_criterion_results"),
    ("conversation_analytics", "session_analyses"),
    ("conversation_analytics", "session_routes"),
    ("conversation_analytics", "run_failures"),
    ("conversation_analytics", "analysis_runs"),
    ("commerce", "participants"),
    ("commerce", "messages"),
    ("commerce", "sessions"),
]
KEEP: list[tuple[str, str]] = [
    ("conversation_config", "evaluation_rubrics"), ("conversation_config", "evaluation_criteria"), ("conversation_config", "evaluation_policies"),
    ("conversation_config", "app_users"), ("conversation_config", "audit_log"), ("conversation_analytics", "ai_spend"),
    ("conversation_config", "run_requests"), ("conversation_config", "run_schedules"),
]
TENANT = "organization_id = @org AND workspace_id = @ws"


def _ref(project: str, dataset: str, table: str) -> str:
    return f"`{project}.{dataset}.{table}`"


def check_tenant(org: str, workspace: str, *, allow_any: bool) -> None:
    if not org or not workspace or any(c in org + workspace for c in "'\"`; "):
        raise SystemExit("invalid organization or workspace")
    if not allow_any and not (org.startswith(TEST_ORG_PREFIX) or org in TEST_ORGS):
        raise SystemExit(f"'{org}' is not a test organization (synthetic-* or org-test). Use --allow-any-tenant only if you really mean it.")


def count_sql(project: str, dataset: str, table: str) -> str:
    return f"SELECT COUNT(*) AS n FROM {_ref(project, dataset, table)} WHERE {TENANT}"


def delete_sql(project: str, dataset: str, table: str) -> str:
    return f"DELETE FROM {_ref(project, dataset, table)} WHERE {TENANT}"


def run(client: Any, project: str, org: str, workspace: str, *, apply: bool, out: Any = print) -> int:
    """0 = done (or a dry run), 1 = stopped by an error before finishing. `client` is a google.cloud.bigquery.Client."""
    from google.cloud import bigquery

    cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("org", "STRING", org), bigquery.ScalarQueryParameter("ws", "STRING", workspace)])

    def count(dataset: str, table: str) -> int | None:
        """None when the table does not exist in this environment (nothing to delete there)."""
        from google.api_core.exceptions import NotFound

        try:
            return int(list(client.query(count_sql(project, dataset, table), job_config=cfg).result())[0]["n"])
        except NotFound:
            return None

    def show(n: int | None) -> str:
        return f"{n:>6} row(s)" if n is not None else "   (table does not exist here)"

    out(f"Workspace {org}/{workspace}")
    todo = [(d, t, count(d, t)) for d, t in DELETE]
    for d, t, n in todo:
        out(f"  {'delete' if apply else 'would delete':<13} {d}.{t:<28} {show(n)}")
    for d, t in KEEP:
        out(f"  keeps         {d}.{t:<28} {show(count(d, t))}")
    if not apply:
        out("Dry run: nothing was changed (add --apply to delete).")
        return 0
    for d, t, n in todo:
        if not n:  # nothing there, or the table does not exist in this environment
            continue
        try:
            client.query(delete_sql(project, d, t), job_config=cfg).result()
        except Exception as exc:  # noqa: BLE001  (a streaming buffer is the expected reason; the message says what to do)
            text = str(exc)
            hint = " The rows were written by a streaming insert, which BigQuery cannot delete for about 90 minutes: run it again later." if "streaming buffer" in text else ""
            out(f"STOPPED at {d}.{t}: {type(exc).__name__}.{hint} Nothing after it was deleted.")
            return 1
        out(f"  deleted       {d}.{t} ({n} row(s))")
    left = sum(count(d, t) or 0 for d, t in DELETE)
    out(f"Done. Rows left in the cleaned tables: {left}.")
    return 0 if left == 0 else 1


def main() -> None:  # pragma: no cover - needs real GCP
    from google.cloud import bigquery

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--project", required=True)
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--apply", action="store_true", help="really delete (the default only shows what would be deleted)")
    p.add_argument("--allow-any-tenant", action="store_true", help="allow an organization that is not a test one")
    a = p.parse_args()
    check_tenant(a.org, a.workspace, allow_any=a.allow_any_tenant)
    raise SystemExit(run(bigquery.Client(project=a.project, location="US"), a.project, a.org, a.workspace, apply=a.apply))


if __name__ == "__main__":
    main()
