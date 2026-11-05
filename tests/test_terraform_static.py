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


# ---- console executor (Cloud Run Job) ----
def test_executor_exists_only_with_an_image_and_every_spending_switch_defaults_off():
    v = (PLATFORM / "variables.tf").read_text()
    assert re.search(r'variable "executor_image" \{[^}]*default\s*=\s*""', v, re.S)
    for name in ("executor_ai_enabled", "executor_attach_openai_secret"):
        assert re.search(rf'variable "{name}" \{{[^}}]*default\s*=\s*false', v, re.S), name
    assert re.search(r'variable "executor_schedule" \{[^}]*default\s*=\s*""', v, re.S)  # no scheduler unless asked
    ex = (PLATFORM / "executor.tf").read_text()
    resources = re.findall(r'resource "(\w+)" "(\w+)" \{\s*\n\s*(count|for_each)\s*=', ex)
    assert len(resources) == len(re.findall(r'(?m)^resource "', ex)), "every executor resource must be conditional"


def test_executor_is_a_job_not_a_server_and_never_retries_blindly():
    ex = (PLATFORM / "executor.tf").read_text()
    assert 'resource "google_cloud_run_v2_job" "executor"' in ex and "google_cloud_run_v2_service" not in ex
    assert "max_retries     = 0" in ex
    assert not (PLATFORM / "executor.tf").read_text().count("min_instance_count")  # a job has no always-on instance


def test_executor_identity_is_least_privilege():
    ex = tf_text(PLATFORM).split('resource "google_service_account" "executor"')[1]
    assert "google_bigquery_table_iam_member" in ex and 'table_id   = google_bigquery_table.tables["run_requests"].table_id' in ex
    # it may write ONE configuration table; rubrics, policies and users stay read-only
    assert not re.search(r"google_bigquery_dataset_iam_member\" \"executor_config\w*\" \{[^}]*result_writer", ex, re.S)
    assert "roles/run.invoker" in ex and "roles/run.admin" not in ex and "roles/editor" not in ex


def test_executor_arguments_match_the_cli_it_runs():
    import shlex  # noqa: F401

    from sci_console_executor.main import parse

    ex = (PLATFORM / "executor.tf").read_text()
    flags = set(re.findall(r'"(--[a-z-]+)"', ex))
    parser_text = (TF.parent.parent / "apps" / "console-executor" / "src" / "sci_console_executor" / "main.py").read_text()
    for flag in flags:
        assert f'"{flag}"' in parser_text, f"terraform passes {flag} but the executor does not accept it"
    a = parse(
        [
            "once",
            "--project",
            "p-123456",
            "--location",
            "US",
            "--tenant",
            "o/w",
            "--limit",
            "3",
            "--max-cost-ceiling",
            "1",
            "--max-sessions-ceiling",
            "1000",
            "--provider",
            "decisions",
            "--input-price-per-million",
            "0.125",
            "--output-price-per-million",
            "0.5",
        ]
    )
    assert a.mode == "once"


def test_executor_dockerfile_installs_every_package_it_imports():
    d = (TF.parent.parent / "apps" / "console-executor" / "Dockerfile").read_text()
    for pkg in (
        "packages/evaluation-core",
        "packages/bigquery-adapter",
        "packages/openai-adapter",
        "apps/workers",
        "apps/console-executor",
    ):
        assert f"COPY {pkg} " in d, pkg
    assert "sci_console_executor.main" in d and "USER appuser" in d


# ---- GitHub Actions federation ----
def test_github_federation_is_off_by_default_and_every_resource_is_conditional():
    v = (PLATFORM / "variables.tf").read_text()
    assert re.search(r'variable "github_repository" \{[^}]*default\s*=\s*""', v, re.S)
    gh = (PLATFORM / "github.tf").read_text()
    assert len(re.findall(r'(?m)^resource "', gh)) == len(re.findall(r"(?m)^\s+count\s*=\s*local\.github_on \? 1 : 0", gh))


def test_github_token_is_trusted_only_for_one_repository_id_and_one_ref():
    """The repository is public: without the condition any workflow on GitHub could obtain a token."""
    gh = (PLATFORM / "github.tf").read_text()
    assert "assertion.repository_id == '${var.github_repository_id}' && assertion.ref == '${var.github_ref}'" in gh
    assert "attribute.repository_id/${var.github_repository_id}" in gh  # impersonation is also scoped to the id, never to the whole pool
    assert "/*" not in gh and "principal://" not in gh
    assert re.search(r'variable "github_ref" \{[^}]*default\s*=\s*"refs/heads/main"', (PLATFORM / "variables.tf").read_text(), re.S)


def test_github_identity_can_only_push_images_to_the_one_repository():
    gh = re.sub(r"(?m)^\s*#.*$", "", (PLATFORM / "github.tf").read_text())
    roles = re.findall(r'role\s*=\s*"([^"]+)"', gh)
    assert sorted(roles) == ["roles/artifactregistry.writer", "roles/iam.workloadIdentityUser"]
    assert "google_artifact_registry_repository_iam_member" in gh and "google_project_iam_member" not in gh  # repository scope, not project


# ---- live worker AI switch ----
def test_live_ai_is_off_by_default_and_cannot_be_turned_on_without_a_key_and_a_monthly_cap():
    v = (PLATFORM / "variables.tf").read_text()
    assert re.search(r'variable "live_ai_enabled" \{[^}]*default\s*=\s*false', v, re.S)
    assert re.search(r'variable "live_monthly_budget_usd" \{[^}]*default\s*=\s*0\b', v, re.S)
    run = (PLATFORM / "run.tf").read_text()
    assert "AI_ENABLED              = tostring(var.live_ai_enabled)" in run  # the live worker has its own switch, not the historical one
    assert "!var.live_ai_enabled || (var.attach_openai_secret && var.live_monthly_budget_usd > 0)" in run


def test_live_env_names_match_what_the_worker_reads():
    run = (PLATFORM / "run.tf").read_text()
    ai = (Path(__file__).parent.parent / "apps" / "workers" / "src" / "sci_workers" / "live_ai.py").read_text()
    for name in ("LIVE_PROVIDER", "LIVE_MODEL", "LIVE_EVIDENCE_MODEL", "LIVE_SUMMARY_MODEL", "LIVE_MONTHLY_BUDGET_USD"):
        assert re.search(rf"\b{name}\b", run) and f'"{name}"' in ai, name



def test_the_openai_key_is_readable_only_by_workloads_that_exist():
    iam = (PLATFORM / "iam.tf").read_text()
    block = iam[iam.index('resource "google_secret_manager_secret_iam_member" "openai_key_access"'):]
    block = block[: block.index("\n}\n")]
    assert 'k != "historical" || local.historical_on' in block  # the historical identity gets the key only once its job is deployed
    assert '"roles/secretmanager.secretAccessor"' in block and "secretmanager.admin" not in tf_text(PLATFORM)


def test_the_result_writer_role_can_run_a_load_job_and_still_cannot_delete():
    """A BigQuery load job needs tables.create, tables.updateData, tables.update and jobs.create even to append (found on the first real live analysis)."""
    iam = (PLATFORM / "iam.tf").read_text()
    block = iam[iam.index('resource "google_project_iam_custom_role" "result_writer"'):]
    block = block[: block.index("\n}\n")]
    perms = set(re.findall(r'"(bigquery\.[A-Za-z.]+)"', block))
    assert {"bigquery.tables.create", "bigquery.tables.updateData", "bigquery.tables.update"} <= perms
    assert not any(p.endswith(".delete") or ".datasets." in p and p != "bigquery.datasets.get" for p in perms)  # no delete of tables or datasets
    assert re.search(r'role\s*=\s*"roles/bigquery\.jobUser"', iam)  # bigquery.jobs.create comes from here (project level)


# ---- conversation ingest ----
def _ingest() -> str:
    return re.sub(r"(?m)^\s*#.*$", "", (PLATFORM / "ingest.tf").read_text())


def test_ingest_exists_only_with_an_image_and_every_resource_is_conditional():
    v = (PLATFORM / "variables.tf").read_text()
    assert re.search(r'variable "ingest_image" \{[^}]*default\s*=\s*""', v, re.S)
    assert re.search(r'variable "producer_members" \{[^}]*default\s*=\s*\[\]', v, re.S)  # nobody may publish until somebody is named
    ing = _ingest()
    assert len(re.findall(r'(?m)^resource "', ing)) == len(re.findall(r"(?m)^  (count|for_each)\s*=", ing))  # top-level only (not a dynamic block's)


def test_only_the_named_producers_may_publish_and_only_to_the_ingest_topic():
    ing = _ingest()
    block = ing[ing.index('resource "google_pubsub_topic_iam_member" "producers"'):]
    block = block[: block.index("\n}\n")]
    assert "topic    = google_pubsub_topic.conversations[0].name" in block and 'role     = "roles/pubsub.publisher"' in block
    assert "toset(var.producer_members)" in block
    v = (PLATFORM / "variables.tf").read_text()
    assert "(serviceAccount|user|group):" in v and "allUsers" not in tf_text(PLATFORM)  # public principals are refused by the validation
    assert "roles/pubsub.admin" not in tf_text(PLATFORM) and "roles/pubsub.editor" not in tf_text(PLATFORM)


def test_the_ingest_identity_can_write_the_source_tables_announce_events_and_nothing_else():
    ing = _ingest()
    role = ing[ing.index('resource "google_project_iam_custom_role" "source_writer"'):]
    perms = set(re.findall(r'"(bigquery\.[A-Za-z.]+)"', role[: role.index("\n}\n")]))
    assert perms == {"bigquery.datasets.get", "bigquery.tables.get", "bigquery.tables.getData", "bigquery.tables.updateData"}  # no create, update, delete
    assert 'dataset_id = var.source_dataset' in ing and 'role    = "roles/bigquery.jobUser"' in ing
    publishers = re.findall(r'topic\s*=\s*([^\n]+)\n\s*role\s*=\s*"roles/pubsub.publisher"\n\s*member\s*=\s*"serviceAccount:\$\{google_service_account.ingest', ing)
    assert publishers == ["google_pubsub_topic.session_updates.name"]  # the service publishes to the live worker's topic and to no other
    assert "analytics" not in ing.split('resource "google_cloud_run_v2_service" "ingest"')[0].replace("analytics_dataset", "")  # no access to the results


def test_the_ingest_service_env_matches_what_ingest_main_reads_and_only_pubsub_may_call_it():
    ing = _ingest()
    main = (Path(__file__).parent.parent / "apps" / "workers" / "src" / "sci_workers" / "ingest_main.py").read_text()
    for name in ("GCP_PROJECT", "SERVICE_URL", "EVENTS_TOPIC", "PUBSUB_PUSH_SA", "INGEST_TENANTS"):
        assert re.search(rf"\b{name}\b", ing) and f'"{name}"' in main, name
    assert 'command = ["python", "-m", "sci_workers.ingest_main"]' in ing and "min_instance_count = 0" in ing
    invoker = ing[ing.index('resource "google_cloud_run_v2_service_iam_member" "ingest_invoker"'):]
    assert "serviceAccount:${google_service_account.pubsub_push.email}" in invoker[: invoker.index("\n}\n")]
    assert "OPENAI" not in ing and "secret" not in ing.lower()  # ingestion never touches the AI key
    sub = ing[ing.index('resource "google_pubsub_subscription" "conversations_ingest"'):]
    assert "dead_letter_policy" in sub and "retry_policy" in sub and '${local.ingest_url}/pubsub/push' in sub


def test_the_executor_cannot_be_scheduled_or_given_ai_without_the_controls_that_make_it_safe():
    ex = (PLATFORM / "executor.tf").read_text()
    # AI on needs the key and a monthly budget; a trigger needs the AI gate open (a closed gate would turn every poll that finds a request into an error)
    assert "!var.executor_ai_enabled || (var.executor_attach_openai_secret && var.executor_monthly_budget_usd > 0)" in ex
    assert 'var.executor_schedule == "" || var.executor_ai_enabled' in ex
    assert "EXECUTOR_MONTHLY_BUDGET_USD" in ex
    # the general evaluation is one more paid call: it needs the AI gate too, and the name the job reads is the name Terraform sets
    assert 'var.executor_summary_model == "" || var.executor_ai_enabled' in ex and "EXECUTOR_SUMMARY_MODEL" in ex
    assert "EXECUTOR_SUMMARY_MODEL" in (Path(__file__).parent.parent / "apps" / "console-executor" / "src" / "sci_console_executor" / "main.py").read_text()
    run = (PLATFORM / "run.tf").read_text()
    assert 'var.live_summary_model == "" || var.live_ai_enabled' in run and "LIVE_SUMMARY_MODEL      = var.live_summary_model" in run
    dev = (TF / "environments" / "dev" / "main.tf").read_text()
    for v in ("executor_monthly_budget_usd", "executor_max_cost_ceiling", "executor_max_sessions_ceiling", "executor_limit", "executor_schedule"):
        assert f"{v}" in dev, v


def test_a_job_or_service_that_reads_the_key_waits_for_its_grant():
    """A first apply once failed with 'Permission denied on secret': the revision was created before the identity could read the secret."""
    for name, text in (("executor.tf", (PLATFORM / "executor.tf").read_text()), ("run.tf", (PLATFORM / "run.tf").read_text())):
        for block in re.findall(r'resource "google_cloud_run_v2_(?:job|service)" "\w+" \{.*?\n\}\n', text, re.S):
            if "OPENAI_API_KEY" in block:
                assert "google_secret_manager_secret_iam_member." in block.split("depends_on")[-1], name


def test_the_producer_identity_can_only_publish_to_the_conversations_topic_and_its_key_is_never_in_terraform():
    pr = (PLATFORM / "producer.tf").read_text()
    assert pr.count('resource "') == 2 and 'resource "google_service_account" "producer"' in pr
    assert re.search(r'role\s+= "roles/pubsub.publisher"', pr) and "google_pubsub_topic.conversations[0].name" in pr
    # a key in Terraform would sit in the state; it is created by a person (docs/producer-guide.md)
    assert "google_service_account_key" not in tf_text(PLATFORM)
    assert "producer_service_account" in (PLATFORM / "variables.tf").read_text() and "producer_aws" not in tf_text(PLATFORM)
    assert "serviceAccounts.keys.create" not in pr and "roles/editor" not in pr and "roles/owner" not in pr


def test_the_general_evaluation_has_its_table_and_the_rubric_its_prompt_column():
    every = {**TABLE_FILES, **CONSOLE_FILES}
    t = parse_tables(every)
    cols = {c["name"]: c for c in t["session_summaries"]["columns"]}
    assert cols["overall_summary"]["mode"] == "REQUIRED" and cols["analysis_id"]["mode"] == "REQUIRED"
    assert all(cols[k]["type"] == "JSON" for k in ("strengths", "weaknesses", "opportunities"))
    prompt = next(c for c in t["evaluation_rubrics"]["columns"] if c["name"] == "summary_prompt")
    assert prompt["type"] == "STRING" and prompt["mode"] == "NULLABLE"  # additive and nullable: a plain schema update, no data touched
    data = (PLATFORM / "data.tf").read_text()
    assert 'session_summaries         = "generated_at"' in data and "session_summaries" in (PLATFORM / "locals.tf").read_text()
