"""Copies a PUBLISHED rubric of one workspace into another workspace as a DRAFT (version 1 unless told otherwise). No AI is called, nothing is paid.

Used to onboard a workspace (for example a test workspace for a producer): the rubric is copied unchanged, then an ADMIN of the new workspace reviews and
publishes it in the console (the publication is audited there). Refuses to overwrite: the destination version must not exist.

Run: python scripts/copy_rubric_to_workspace.py --project P --from synthetic-a/default --to cliente-teste/default --rubric-id sales_quality --from-version 5
"""
import argparse

from google.cloud import bigquery

COPY_CRITERIA = (
    "INSERT INTO {c}.evaluation_criteria` (organization_id, workspace_id, rubric_id, rubric_version, criterion_id, criterion_name, evaluation_instructions, "
    "evaluation_type, weight, required, enabled, applicability_rule, score_mapping, choices, score_levels, display_order) "
    "SELECT @to_org, @to_ws, rubric_id, @to_version, criterion_id, criterion_name, evaluation_instructions, evaluation_type, weight, required, enabled, "
    "applicability_rule, score_mapping, choices, score_levels, display_order FROM {c}.evaluation_criteria` "
    "WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND rubric_version=@from_version"
)
COPY_POLICY = (
    "INSERT INTO {c}.evaluation_policies` (organization_id, workspace_id, rubric_id, rubric_version, minimum_approval_score, missing_evidence_policy, "
    "not_applicable_policy, max_analyses_per_session, max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages) "
    "SELECT @to_org, @to_ws, rubric_id, @to_version, minimum_approval_score, missing_evidence_policy, not_applicable_policy, max_analyses_per_session, "
    "max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages FROM {c}.evaluation_policies` "
    "WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND rubric_version=@from_version"
)
COPY_RUBRIC = (
    "INSERT INTO {c}.evaluation_rubrics` (organization_id, workspace_id, rubric_id, version, name, status, published_at, created_at, description) "
    "SELECT @to_org, @to_ws, rubric_id, @to_version, name, 'DRAFT', NULL, CURRENT_TIMESTAMP(), description FROM {c}.evaluation_rubrics` "
    "WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND version=@from_version"
)


def tenant(text: str) -> tuple[str, str]:
    org, _, ws = text.partition("/")
    if not org or not ws:
        raise argparse.ArgumentTypeError("use organization/workspace")
    return org, ws


def main() -> None:
    a = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    a.add_argument("--project", required=True)
    a.add_argument("--from", dest="src", type=tenant, required=True)
    a.add_argument("--to", dest="dst", type=tenant, required=True)
    a.add_argument("--rubric-id", required=True)
    a.add_argument("--from-version", type=int, required=True)
    a.add_argument("--to-version", type=int, default=1)
    a = a.parse_args()
    if a.src == a.dst:
        raise SystemExit("source and destination are the same workspace")
    client = bigquery.Client(project=a.project)
    c = f"`{a.project}.conversation_config"

    def run(sql: str) -> list:
        params = [bigquery.ScalarQueryParameter(k, "INT64" if isinstance(v, int) else "STRING", v) for k, v in {
            "org": a.src[0], "ws": a.src[1], "to_org": a.dst[0], "to_ws": a.dst[1], "rid": a.rubric_id,
            "from_version": a.from_version, "to_version": a.to_version}.items()]
        return list(client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())

    status = run(f"SELECT status FROM {c}.evaluation_rubrics` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND version=@from_version")
    if not status or status[0].status != "PUBLISHED":
        raise SystemExit("the source version does not exist or is not PUBLISHED")
    if run(f"SELECT 1 FROM {c}.evaluation_rubrics` WHERE organization_id=@to_org AND workspace_id=@to_ws AND rubric_id=@rid AND version=@to_version"):
        raise SystemExit("the destination already has this rubric version: nothing was written")
    for sql in (COPY_RUBRIC, COPY_CRITERIA, COPY_POLICY):
        run(sql.format(c=c))
    n = run(f"SELECT COUNT(*) AS n FROM {c}.evaluation_criteria` WHERE organization_id=@to_org AND workspace_id=@to_ws AND rubric_id=@rid AND rubric_version=@to_version")[0].n
    print(f"copied {a.rubric_id} v{a.from_version} of {a.src[0]}/{a.src[1]} to {a.dst[0]}/{a.dst[1]} as DRAFT v{a.to_version} ({n} criteria). Publish it in the console.")


if __name__ == "__main__":
    main()
