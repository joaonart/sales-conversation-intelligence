"""Static guarantees for infra/terraform that do not need the terraform binary or credentials."""
import json
import re
from pathlib import Path

import pytest

from tests.ddl_schema import CONSOLE_FILES, SQL_DIR, TABLE_FILES, parse_tables

TF = Path(__file__).parent.parent / "infra" / "terraform"
PLATFORM = TF / "modules" / "platform"


def tf_text(root: Path = TF) -> str:
    code = "\n".join(p.read_text() for p in sorted(root.rglob("*.tf")))
    return re.sub(r"(?m)^\s*#.*$", "", code)  # comments may legitimately mention forbidden terms


def hcl_map(name: str) -> dict[str, list[str] | str]:
    body = re.search(rf"{name}\s*=\s*\{{(.*?)\n  \}}", (PLATFORM / "data.tf").read_text(), re.S).group(1)
    out: dict = {}
    for key, val in re.findall(r"(\w+)\s*=\s*(\[[^\]]*\]|\"[^\"]*\")", body):
        out[key] = re.findall(r"\"([^\"]+)\"", val) if val.startswith("[") else val.strip('"')
    return out


def test_table_schemas_match_ddl():
    every = {**TABLE_FILES, **CONSOLE_FILES}
    for name, spec in parse_tables(every).items():
        on_disk = json.loads((PLATFORM / "schemas" / f"{name}.json").read_text())
        assert on_disk == spec["columns"], f"{name}: regenerate schemas from sql/ (drift)"
    assert {p.stem for p in (PLATFORM / "schemas").glob("*.json")} == set(parse_tables(every))


def test_partitioning_and_clustering_match_ddl():
    parts, clusters = hcl_map("partitions"), hcl_map("clustering")
    for name, spec in parse_tables({**TABLE_FILES, **CONSOLE_FILES}).items():
        assert parts.get(name) == spec["partition_field"], name
        assert clusters.get(name, []) == spec["cluster"], name


def test_latest_view_matches_sql_script():
    norm = lambda s: re.sub(r"\s+", " ", s).strip().rstrip(";")  # noqa: E731
    view = (PLATFORM / "views" / "latest_session_analyses.sql").read_text()
    view = view.replace("${project}", "PROJECT_ID").replace("${dataset}", "conversation_analytics")
    script = (SQL_DIR / "03_latest_view.sql").read_text()
    assert norm(view) in norm(re.sub(r"--[^\n]*", "", script))


def test_no_public_access_keys_or_primitive_roles():
    text = tf_text()
    for forbidden in ("allUsers", "allAuthenticatedUsers", "google_service_account_key", "roles/owner", "roles/editor",
                      "google_secret_manager_secret_version", "secret_data", "roles/bigquery.admin", "roles/run.admin"):
        assert forbidden not in text, forbidden


def test_destructive_defaults_are_off():
    text = tf_text()
    assert "delete_contents_on_destroy = false" in text
    assert len(re.findall(r"disable_on_destroy\s*=\s*false", text)) == 1
    prod = (TF / "environments" / "prod" / "main.tf").read_text()
    assert re.search(r"deletion_protection\s*=\s*true", prod) and 'backend "gcs"' in prod


def test_nothing_paid_runs_by_default():
    v = (PLATFORM / "variables.tf").read_text()
    for img in ("api_image", "live_image", "historical_image"):
        assert re.search(rf'variable "{img}" \{{[^}}]*default\s*=\s*""', v), img
    assert re.search(r'variable "ai_enabled" \{[^}]*default\s*=\s*false', v, re.S)
    assert re.search(r'variable "attach_openai_secret" \{[^}]*default\s*=\s*false', v, re.S)
    run = (PLATFORM / "run.tf").read_text()
    assert run.count("min_instance_count = 0") == 2 and "max_instance_count" in run


def test_project_and_region_are_explicit_everywhere():
    for env in ("dev", "prod"):
        main = (TF / "environments" / env / "main.tf").read_text()
        assert "project = var.project_id" in main and "region  = var.region" in main
        v = (TF / "environments" / env / "variables.tf").read_text()
        for req in ("project_id", "region", "bq_location"):
            assert not re.search(rf'variable "{req}" \{{[^}}]*default', v), f"{env}.{req} must have no default"


def test_dataset_ids_have_no_hyphen_and_match_adapter_defaults():
    from sci_bq.tables import Tables
    t = Tables("my-proj-123")
    v = (PLATFORM / "variables.tf").read_text()
    for var, expected in (("config_dataset", t.config_dataset), ("analytics_dataset", t.analytics_dataset),
                          ("source_dataset", t.source_dataset)):
        assert re.search(rf'variable "{var}" \{{[^}}]*default\s*=\s*"{expected}"', v, re.S), var
    assert "${var.name_prefix}" not in (PLATFORM / "data.tf").read_text().split("resource \"google_bigquery_table\"")[0]


def test_live_worker_wiring_matches_code():
    """Env var names and URL shapes consumed by sci_workers.live_main / live_auth."""
    run = (PLATFORM / "run.tf").read_text()
    for name in ("SERVICE_URL", "SCI_TENANTS", "TASKS_QUEUE", "TASKS_INVOKER_SA", "PUBSUB_PUSH_SA", "GCP_PROJECT", "REGION", "AI_ENABLED"):
        assert re.search(rf"\b{name}\b", run), name
    main = (Path(__file__).parent.parent / "apps" / "workers" / "src" / "sci_workers" / "live_main.py").read_text()
    for name in ("SERVICE_URL", "SCI_TENANTS", "TASKS_QUEUE", "TASKS_INVOKER_SA", "PUBSUB_PUSH_SA"):
        assert f'"{name}"' in main
    msg = (PLATFORM / "messaging.tf").read_text()
    assert '"${local.live_url}/pubsub/push"' in msg  # audience == verifier audience (service_url + /pubsub/push)
    assert "dead_letter_policy" in msg and "retry_policy" in msg


@pytest.mark.parametrize("resource", ["google_billing_budget", "google_monitoring_alert_policy"])
def test_finops_resources_present(resource):
    assert resource in (PLATFORM / "finops.tf").read_text()


def test_log_metrics_only_reference_fields_and_events_the_code_emits():
    from sci_core.obs import ALLOWED_FIELDS

    obs = (PLATFORM / "observability.tf").read_text()
    fields = set(re.findall(r"jsonPayload\.(\w+)", obs)) - {"logger"}
    assert fields and fields <= ALLOWED_FIELDS, fields - ALLOWED_FIELDS
    src = "\n".join(p.read_text() for p in (TF.parent.parent / "apps" / "workers" / "src").rglob("*.py")) + \
          "\n".join(p.read_text() for p in (TF.parent.parent / "packages" / "evaluation-core" / "src").rglob("*.py"))
    for event in set(re.findall(r'jsonPayload\.event=\\"(\w+)\\"', obs)):
        assert f'"event": "{event}"' in src, f"no code emits event {event!r}"
