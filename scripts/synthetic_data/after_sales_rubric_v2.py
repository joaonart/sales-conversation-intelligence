"""Creates the DRAFT revision `after_sales_quality` v2 in both dev synthetic workspaces, from the published v1 (refuses to overwrite). No AI is called.

v1 made `understanding` and `resolution` required, so a middle level (50) rejected an analysis whose overall score passed (pilot, s0004).
v2 keeps `resolution` required (the solution is the heart of a support conversation) and makes `understanding` optional: a partial understanding
lowers the score, it no longer rejects by itself. Everything else is copied unchanged. Publishing is done in the console.

Run: python scripts/synthetic_data/after_sales_rubric_v2.py
"""
from google.cloud import bigquery

P = "jnart-intelligence-513001"
C = f"`{P}.conversation_config"
RID, FROM_V, NEW_V = "after_sales_quality", 1, 2
NAME = "Qualidade do pós-venda (compreensão não obrigatória)"
DESC = "v2: compreensão do problema deixa de ser obrigatória; a solução continua obrigatória"
client = bigquery.Client(project=P)


def run(sql: str, **params: object) -> list:
    qp = [bigquery.ScalarQueryParameter(k, "INT64" if isinstance(v, int) else "STRING", v) for k, v in params.items()]
    return list(client.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp)).result())


for org in ("synthetic-a", "synthetic-b"):
    p = {"org": org, "ws": "default", "rid": RID, "src": FROM_V, "dst": NEW_V}
    assert run(f"SELECT status FROM {C}.evaluation_rubrics` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND version=@src", **p)[0].status == "PUBLISHED", "v1 must be published"
    assert not run(f"SELECT 1 FROM {C}.evaluation_rubrics` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND version=@dst", **p), f"{org} already has v{NEW_V}"
    run(f"INSERT INTO {C}.evaluation_rubrics` (organization_id, workspace_id, rubric_id, version, name, status, published_at, created_at, description) "
        "SELECT organization_id, workspace_id, rubric_id, @dst, @name, 'DRAFT', NULL, CURRENT_TIMESTAMP(), @desc "
        f"FROM {C}.evaluation_rubrics` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND version=@src", name=NAME, desc=DESC, **p)
    run(f"INSERT INTO {C}.evaluation_criteria` (organization_id, workspace_id, rubric_id, rubric_version, criterion_id, criterion_name, evaluation_instructions, "
        "evaluation_type, weight, required, enabled, applicability_rule, score_mapping, choices, score_levels, display_order) "
        "SELECT organization_id, workspace_id, rubric_id, @dst, criterion_id, criterion_name, evaluation_instructions, evaluation_type, weight, "
        "IF(criterion_id = 'understanding', FALSE, required), enabled, applicability_rule, score_mapping, choices, score_levels, display_order "
        f"FROM {C}.evaluation_criteria` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND rubric_version=@src", **p)
    run(f"INSERT INTO {C}.evaluation_policies` (organization_id, workspace_id, rubric_id, rubric_version, minimum_approval_score, missing_evidence_policy, "
        "not_applicable_policy, max_analyses_per_session, max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages) "
        "SELECT organization_id, workspace_id, rubric_id, @dst, minimum_approval_score, missing_evidence_policy, not_applicable_policy, max_analyses_per_session, "
        "max_input_tokens, monthly_budget_usd, min_messages, min_customer_messages, min_seller_messages "
        f"FROM {C}.evaluation_policies` WHERE organization_id=@org AND workspace_id=@ws AND rubric_id=@rid AND rubric_version=@src", **p)
    print("created", org, RID, f"v{NEW_V}")
