"""Remove the DATA of ONE workspace (its conversations and everything the platform produced from them), to start a test from an empty workspace.

What is deleted (only rows of the given organization AND workspace): the conversations (`commerce.sessions`, `messages`, `participants`) and their
results (`session_criterion_results`, `session_analyses`, `analysis_runs`, `session_routes`, `run_failures`, `review_decisions`), and what "Melhorar prompt"
produced from them (`prompt_improvement_results`: the aggregate that was sent and the suggestions). Also the text of any prompt that was NOT kept
(`agent_prompts` rows with `retained = false`): such a text lives only for its request and is deleted when the request ends, so one still there is a
leftover of a failure.

Last of all, the workspace's rows of the spend ledger (`ai_spend`), so a test also starts with no AI spend on its Painel (the cost tab reads that ledger):
the analyses it paid for are gone, and so are the lines that say what they cost. It is the record the monthly caps read, so it is cleared only for a
TEST organization and never with --allow-any-tenant, and `--keep-spend` keeps it. The dry run says how much money it holds; clearing it forgets that
spend (the OpenAI bill does not), so a cap that was nearly reached starts from zero again.

What is NEVER touched, whatever the arguments:
- the rubrics (`evaluation_rubrics`, `evaluation_criteria`, `evaluation_policies`): published rubrics are immutable and the next test needs them;
- who can use the console (`app_users`) and the trail of who did what (`audit_log`): deleting them would lock people out and erase the evidence
  (the audit trail of a test workspace has its own process: `scripts/clean_audit.py`);
- the spend ledger of an organization that is NOT a test one (see above): the financial record of a real tenant is never erased by this script;
- the prompts people chose to keep (`agent_prompts` with `retained = true`): they are their own content, like the rubrics, and the next test reuses them;
- the requests and schedules made in the console (`run_requests`, `run_schedules`, `prompt_improvement_requests`).

Safety:
- Dry run by default: it prints what it would delete and what it keeps. Nothing changes without --apply.
- Only a test workspace: the organization must start with `synthetic-` or be `org-test`, unless --allow-any-tenant is given on purpose.
- Every statement carries `organization_id = ... AND workspace_id = ...`: no other tenant is touched (the counts of what stays are printed).
- BigQuery time travel can bring the rows back for 48 hours on the platform datasets.
- Rows written by a streaming insert (the conversation messages, and the lines of the spend ledger) cannot be deleted for roughly the first 90 minutes:
  if that is the case it stops there and says so, instead of leaving the workspace half cleaned; run it again later. The ledger is the last step, so
  recent spend can leave the data cleaned and only the ledger for a second run (it says so).

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
    ("conversation_config", "prompt_improvement_results"),
    ("conversation_analytics", "session_summaries"),
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
    ("conversation_config", "app_users"), ("conversation_config", "audit_log"),
    ("conversation_config", "run_requests"), ("conversation_config", "run_schedules"), ("conversation_config", "prompt_improvement_requests"),
]
# The text of a prompt that was not kept: only those rows are deleted (a kept prompt is never touched, whatever the arguments).
TEMP_PROMPTS: tuple[str, str] = ("conversation_config", "agent_prompts")
NOT_KEPT = "AND NOT retained"
# The spend ledger: one line per paid call, cleared last and only for a test organization (see `spend_is_cleanable`).
SPEND: tuple[str, str] = ("conversation_analytics", "ai_spend")
TENANT = "organization_id = @org AND workspace_id = @ws"


def _ref(project: str, dataset: str, table: str) -> str:
    return f"`{project}.{dataset}.{table}`"


def is_test_org(org: str) -> bool:
    return org.startswith(TEST_ORG_PREFIX) or org in TEST_ORGS


def spend_is_cleanable(org: str, *, keep_spend: bool) -> bool:
    """The ledger is cleared only for a test organization and only when --keep-spend was not given (a real tenant's spend is a financial record)."""
    return is_test_org(org) and not keep_spend


def check_tenant(org: str, workspace: str, *, allow_any: bool) -> None:
    if not org or not workspace or any(c in org + workspace for c in "'\"`; "):
        raise SystemExit("invalid organization or workspace")
    if not allow_any and not is_test_org(org):
        raise SystemExit(f"'{org}' is not a test organization (synthetic-* or org-test). Use --allow-any-tenant only if you really mean it.")


def count_sql(project: str, dataset: str, table: str, extra: str = "") -> str:
    return f"SELECT COUNT(*) AS n FROM {_ref(project, dataset, table)} WHERE {TENANT}{f' {extra}' if extra else ''}"


def delete_sql(project: str, dataset: str, table: str, extra: str = "") -> str:
    return f"DELETE FROM {_ref(project, dataset, table)} WHERE {TENANT}{f' {extra}' if extra else ''}"


def usd_sql(project: str) -> str:
    return f"SELECT IFNULL(SUM(cost_usd), 0) AS usd FROM {_ref(project, *SPEND)} WHERE {TENANT}"


def run(client: Any, project: str, org: str, workspace: str, *, apply: bool, out: Any = print, spend: bool = True) -> int:
    """0 = done (or a dry run), 1 = stopped by an error before finishing. `client` is a google.cloud.bigquery.Client.

    `spend`: also clear the workspace's lines of the spend ledger, last (the caller decides with `spend_is_cleanable`)."""
    from google.cloud import bigquery

    cfg = bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("org", "STRING", org), bigquery.ScalarQueryParameter("ws", "STRING", workspace)])

    def count(dataset: str, table: str, extra: str = "") -> int | None:
        """None when the table does not exist in this environment (nothing to delete there)."""
        from google.api_core.exceptions import NotFound

        try:
            return int(list(client.query(count_sql(project, dataset, table, extra), job_config=cfg).result())[0]["n"])
        except NotFound:
            return None

    def show(n: int | None) -> str:
        return f"{n:>6} row(s)" if n is not None else "   (table does not exist here)"

    out(f"Workspace {org}/{workspace}")
    todo = [(d, t, count(d, t), "") for d, t in DELETE]
    todo.append((*TEMP_PROMPTS, count(*TEMP_PROMPTS, NOT_KEPT), NOT_KEPT))  # last of the data: only the text of prompts that were not kept
    for d, t, n, extra in todo:
        out(f"  {'delete' if apply else 'would delete':<13} {d}.{t:<28} {show(n)}{' (only prompts that were not kept)' if extra else ''}")
    spend_rows = count(*SPEND)
    spend_usd = 0.0
    if spend and spend_rows:
        spend_usd = float(list(client.query(usd_sql(project), job_config=cfg).result())[0]["usd"])
    out(f"  {('delete' if apply else 'would delete') if spend else 'keeps':<13} {SPEND[0]}.{SPEND[1]:<28} {show(spend_rows)}"
        + (f" holding US$ {spend_usd:.6f} of recorded spend (last step)" if spend and spend_rows else ""))
    for d, t in KEEP:
        out(f"  keeps         {d}.{t:<28} {show(count(d, t))}")
    if not apply:
        out("Dry run: nothing was changed (add --apply to delete).")
        return 0
    for d, t, n, extra in todo:
        if not n:  # nothing there, or the table does not exist in this environment
            continue
        try:
            client.query(delete_sql(project, d, t, extra), job_config=cfg).result()
        except Exception as exc:  # noqa: BLE001  (a streaming buffer is the expected reason; the message says what to do)
            text = str(exc)
            hint = " The rows were written by a streaming insert, which BigQuery cannot delete for about 90 minutes: run it again later." if "streaming buffer" in text else ""
            out(f"STOPPED at {d}.{t}: {type(exc).__name__}.{hint} Nothing after it was deleted.")
            return 1
        out(f"  deleted       {d}.{t} ({n} row(s))")
    left = sum(count(d, t, extra) or 0 for d, t, _n, extra in todo)
    if left:
        out(f"Rows left in the cleaned tables: {left}. The spend ledger was not touched.")
        return 1
    if spend and spend_rows:
        try:
            client.query(delete_sql(project, *SPEND), job_config=cfg).result()
        except Exception as exc:  # noqa: BLE001
            hint = " The lines were written by a streaming insert, which BigQuery cannot delete for about 90 minutes." if "streaming buffer" in str(exc) else ""
            out(f"STOPPED at {SPEND[0]}.{SPEND[1]}: {type(exc).__name__}.{hint} The data was cleaned; run it again later to clear the spend ledger.")
            return 1
        out(f"  deleted       {SPEND[0]}.{SPEND[1]} ({spend_rows} row(s), US$ {spend_usd:.6f} of recorded spend)")
    out("Done. Rows left in the cleaned tables: 0" + ("; the spend ledger is cleared too." if spend else "; the spend ledger was kept."))
    return 0


def main() -> None:  # pragma: no cover - needs real GCP
    from google.cloud import bigquery

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--project", required=True)
    p.add_argument("--org", required=True)
    p.add_argument("--workspace", required=True)
    p.add_argument("--apply", action="store_true", help="really delete (the default only shows what would be deleted)")
    p.add_argument("--allow-any-tenant", action="store_true", help="allow an organization that is not a test one (its spend ledger is still never cleared)")
    p.add_argument("--keep-spend", action="store_true", help="keep the workspace's lines of the spend ledger (by default a test workspace's are cleared too)")
    a = p.parse_args()
    check_tenant(a.org, a.workspace, allow_any=a.allow_any_tenant)
    spend = spend_is_cleanable(a.org, keep_spend=a.keep_spend)
    if not spend and not a.keep_spend:
        print(f"Note: '{a.org}' is not a test organization, so its spend ledger is kept.")
    raise SystemExit(run(bigquery.Client(project=a.project, location="US"), a.project, a.org, a.workspace, apply=a.apply, spend=spend))


if __name__ == "__main__":
    main()
