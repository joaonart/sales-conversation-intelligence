"""The console's "Recursos" tab lists everything Terraform creates: a resource added to Terraform without a line there fails this test."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE = ROOT / "infra/terraform/modules/platform"
APP_JS = (ROOT / "apps/admin-console/src/ui/lib/howData.ts").read_text()  # the data the "Como funciona" page shows (steps, architecture, resources)


UNUSED_SOURCE_TABLES = {"participants"}  # defined in sql/00 as part of the sample contract; no code reads or writes it and dev does not have it


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
        assert f"sci-{{env}}_{m}" in APP_JS, m  # the real name is "sci-dev_evaluations": a hyphen after sci, an underscore before the metric
    for role in re.findall(r'role_id\s*=\s*"([A-Za-z]+)"', tf):
        assert f'"{role}"' in APP_JS, role


def test_every_bigquery_table_and_view_is_described():
    sql = "\n".join(p.read_text() for p in sorted((ROOT / "sql").glob("*.sql")))
    tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS `PROJECT_ID\.[a-z_]+\.([a-z_]+)`", sql))
    assert {"sessions", "messages", "participants", "ai_spend", "run_requests", "session_analyses"} <= tables
    for t in tables - UNUSED_SOURCE_TABLES:
        assert f'["{t}", "Tabela"' in APP_JS, t
    for t in UNUSED_SOURCE_TABLES:  # in the sample DDL, but not in any environment and used by nothing: the page must not claim it exists
        assert f'["{t}", "Tabela"' not in APP_JS, t
    views = {p.stem for p in (MODULE / "views").glob("*.sql")}
    assert {"review_queue", "gold_cost_daily", "latest_session_analyses"} <= views
    for v in views:
        assert f'["{v}", "Visão"' in APP_JS, v


def test_a_resource_is_never_described_without_a_reason_and_a_cost():
    block = APP_JS[APP_JS.index("export const RES_GROUPS"):]
    items = re.findall(r'^\s+\["([^"]+)", "([^"]+)", "((?:[^"\\]|\\.)+)", "([^"]+)"\]', block, re.M)
    assert len(items) >= 60
    assert all(len(why) > 20 and cost for _, _, why, cost in items)


# ---- the other direction: nothing is listed that does not exist (the page once listed a table that no environment has) ----
NOT_A_NAMED_RESOURCE = {  # listed on purpose and not declared by name in Terraform or SQL
    "14 APIs do Google Cloud", "Alerta: falhas", "Alerta: latência", "Alerta: fila de mortos do ao vivo", "Alerta: fila de mortos da ingestão",
    "Alerta: aviso parado", "E-mail de alerta", "sci-{env} monthly", "Este console", "OpenAI", "GitHub Actions", "commerce (dataset)",
}


def listed_items() -> list[tuple[str, str]]:
    block = APP_JS[APP_JS.index("export const RES_GROUPS"):]
    return [(n, k) for n, k, _, _ in re.findall(r'^\s+\["([^"]+)", "([^"]+)", "((?:[^"\\]|\\.)+)", "([^"]+)"\]', block, re.M)]


def test_every_listed_resource_is_declared_somewhere():
    tf = terraform_text()
    sql = "\n".join(p.read_text() for p in sorted((ROOT / "sql").glob("*.sql")))
    tables = set(re.findall(r"CREATE TABLE IF NOT EXISTS `PROJECT_ID\.[a-z_]+\.([a-z_]+)`", sql)) - UNUSED_SOURCE_TABLES
    views = {p.stem for p in (MODULE / "views").glob("*.sql")}
    prefixed = set(re.findall(r"\$\{local\.prefix\}-([a-z0-9-]+)", tf)) | {"live", "ingest", "executor"}
    metrics = set(re.findall(r"\$\{local\.prefix\}_([a-z_]+)", tf))
    roles = set(re.findall(r'role_id\s*=\s*"([A-Za-z]+)"', tf))
    unknown = []
    for name, kind in listed_items():
        if name in NOT_A_NAMED_RESOURCE:
            continue
        if kind in ("Tabela", "Visão"):
            ok = name in tables or name in views
        elif name.startswith("sci-{env}-"):
            ok = name.removeprefix("sci-{env}-") in prefixed
        elif name.startswith("sci-{env}_"):
            ok = name.removeprefix("sci-{env}_") in metrics
        else:
            ok = name in roles
        if not ok:
            unknown.append(name)
    assert not unknown, f"listed in the Recursos tab but declared nowhere: {unknown}"


def test_the_number_of_apis_on_the_page_is_the_number_terraform_enables():
    apis = re.findall(r'"([a-z]+\.googleapis\.com)"', (MODULE / "apis.tf").read_text())
    assert f"{len(set(apis))} APIs do Google Cloud" in APP_JS, len(set(apis))


# ---- the organisation of the tab: BigQuery by dataset in Tabelas | Views, secrets and identity in two tabs ----
def _groups() -> list[dict]:
    block = APP_JS[APP_JS.index("export const RES_GROUPS"):]
    out = []
    for chunk in block.split("\n    { id: ")[1:]:
        head = chunk.split("items: [", 1)[0]
        meta = dict(re.findall(r'(\w+): "([^"]*)"', head))
        meta["id"] = chunk.split(",", 1)[0].strip('"')
        meta["items"] = re.findall(r'^\s+\["([^"]+)", "([^"]+)", "(?:[^"\\]|\\.)+", "[^"]+"\]', chunk, re.M)
        out.append(meta)
    return out


def test_every_table_is_listed_under_the_dataset_that_really_holds_it_and_every_tab_holds_one_kind_of_resource():
    sql = "\n".join(p.read_text() for p in sorted((ROOT / "sql").glob("*.sql")))
    dataset_of = {t: ds for ds, t in re.findall(r"CREATE TABLE IF NOT EXISTS `PROJECT_ID\.([a-z_]+)\.([a-z_]+)`", sql)}
    groups = _groups()
    assert {g["tab"] for g in groups if g.get("section") == "bigquery"} == {"tables", "views"}
    for g in groups:
        if g.get("section") != "bigquery":
            continue
        assert g["dataset"] in {"commerce", "conversation_config", "conversation_analytics"}, g["id"]
        for name, kind in g["items"]:
            if g["tab"] == "tables":
                assert kind == "Tabela" and dataset_of[name] == g["dataset"], f"{name} is in {dataset_of.get(name)}, not in {g['dataset']}"
            else:
                assert kind == "Visão" and g["dataset"] == "conversation_analytics", name  # every view lives in the analytics dataset
    tables = {n for g in groups if g.get("tab") == "tables" for n, _ in g["items"]}
    assert tables == {t for t in dataset_of if t != "participants"}, "a table of the DDL is missing from the tab, or the tab lists one the DDL does not have"


def test_secrets_and_identity_are_two_tabs_with_the_right_resources_in_each():
    groups = [g for g in _groups() if g.get("section") == "identity"]
    by_tab: dict[str, list[tuple[str, str]]] = {}
    for g in groups:
        by_tab.setdefault(g["tab"], []).extend(g["items"])
    assert set(by_tab) == {"secrets", "identity"}
    assert {k for _, k in by_tab["secrets"]} == {"Segredo do Secret Manager"}
    assert all(k.startswith(("Conta de serviço", "Papel personalizado", "Pool de identidade")) for _, k in by_tab["identity"])
    assert len(by_tab["secrets"]) == 1 and len(by_tab["identity"]) == 13  # 9 service accounts here (the build one is with the build tools), 3 roles, 1 pool


def test_every_group_of_a_section_has_a_tab_that_section_declares():
    declared = dict(re.findall(r'(\w+): \{ title: "[^"]+", product: "[^"]+", icon: "\w+", tabs: \[(.*?)\],\s+blurb', APP_JS, re.S))
    assert set(declared) == {"bigquery", "identity", "run"}
    for g in _groups():
        if g.get("section"):
            assert f'["{g["tab"]}",' in declared[g["section"]], g["id"]


def test_processing_is_two_tabs_services_and_jobs_and_each_resource_is_in_the_one_that_matches_what_it_is():
    groups = [g for g in _groups() if g.get("section") == "run"]
    by_tab: dict[str, list[tuple[str, str]]] = {}
    for g in groups:
        by_tab.setdefault(g["tab"], []).extend(g["items"])
    assert set(by_tab) == {"services", "jobs"}
    assert all(k.startswith("Serviço do Cloud Run") for _, k in by_tab["services"]), by_tab["services"]
    assert all(k.startswith(("Job do Cloud Run", "Job do Cloud Scheduler")) for _, k in by_tab["jobs"]), by_tab["jobs"]
    assert {n for n, _ in by_tab["services"]} == {"sci-{env}-live", "sci-{env}-ingest", "sci-{env}-api"}
    assert {n for n, _ in by_tab["jobs"]} == {"sci-{env}-executor", "sci-{env}-executor-poll", "sci-{env}-historical"}
    # the Terraform agrees: the services are google_cloud_run_v2_service, the jobs are Cloud Run jobs and a Scheduler job
    tf = "\n".join(p.read_text() for p in MODULE.glob("*.tf"))
    assert len(re.findall(r'resource "google_cloud_run_v2_service"', tf)) == 3
    assert len(re.findall(r'resource "google_cloud_run_v2_job"', tf)) == 2 and len(re.findall(r'resource "google_cloud_scheduler_job"', tf)) == 1

