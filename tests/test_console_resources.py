"""The console's "Recursos" tab lists everything Terraform creates: a resource added to Terraform without a line there fails this test."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "infra/terraform/modules/platform"
APP_JS = (ROOT / "apps/admin-console/src/client/app.js").read_text()


def terraform_text() -> str:
    return "\n".join(p.read_text() for p in sorted(MODULE.glob("*.tf")))


def test_every_named_terraform_resource_is_in_the_resources_tab():
    names = set(re.findall(r"\$\{local\.prefix\}-([a-z0-9-]+)", terraform_text()))
    names |= {"live", "ingest", "executor"}  # local.live_name / local.ingest_name are built from the same prefix
    missing = sorted(n for n in names if f"sci-{{env}}-{n}" not in APP_JS)
    assert not missing, f"not described in the Recursos tab: {missing}"


def test_log_metrics_custom_roles_and_datasets_are_described_too():
    tf = terraform_text()
    for m in re.findall(r"\$\{local\.prefix\}_([a-z_]+)", tf):
        assert f"sci_{{env}}_{m}" in APP_JS, m
    for role in re.findall(r'role_id\s*=\s*"([A-Za-z]+)"', tf):
        assert f'"{role}"' in APP_JS, role


def test_every_bigquery_table_and_view_is_described():
    sql = "\n".join(p.read_text() for p in sorted((ROOT / "sql").glob("*.sql")))
    tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS `PROJECT_ID\.[a-z_]+\.([a-z_]+)`", sql))
    assert {"sessions", "messages", "participants", "ai_spend", "run_requests", "session_analyses"} <= tables
    for t in tables:
        assert f'["{t}", "Tabela"' in APP_JS, t
    views = {p.stem for p in (MODULE / "views").glob("*.sql")}
    assert {"review_queue", "gold_cost_daily", "latest_session_analyses"} <= views
    for v in views:
        assert f'["{v}", "Visão"' in APP_JS, v


def test_a_resource_is_never_described_without_a_reason_and_a_cost():
    block = APP_JS[APP_JS.index("var RES_GROUPS = ["): APP_JS.index("function resourcesView()")]
    items = re.findall(r'^\s+\["([^"]+)", "([^"]+)", "((?:[^"\\]|\\.)+)", "([^"]+)"\]', block, re.M)
    assert len(items) >= 60
    assert all(len(why) > 20 and cost for _, _, why, cost in items)
