# One identity per workload, least privilege, no keys. Roles are granted at dataset/queue/service/secret scope
# wherever the product allows it; only bigquery.jobUser (required to run any job) is project-wide.
resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "${local.prefix}-api"
  display_name = "SCI API (${var.env})"
}

resource "google_service_account" "live" {
  project      = var.project_id
  account_id   = "${local.prefix}-live"
  display_name = "SCI live worker (${var.env})"
}

resource "google_service_account" "historical" {
  project      = var.project_id
  account_id   = "${local.prefix}-hist"
  display_name = "SCI historical job (${var.env})"
}

resource "google_service_account" "tasks_invoker" {
  project      = var.project_id
  account_id   = "${local.prefix}-tasks"
  display_name = "Cloud Tasks -> live worker (${var.env})"
}

resource "google_service_account" "pubsub_push" {
  project      = var.project_id
  account_id   = "${local.prefix}-push"
  display_name = "Pub/Sub push -> live worker (${var.env})"
}

# Writer on analytics: append results via load jobs; cannot delete tables or change schema.
resource "google_project_iam_custom_role" "result_writer" {
  project     = var.project_id
  role_id     = "sciResultWriter"
  title       = "SCI result writer"
  description = "Read and append to analytics tables."
  permissions = [
    "bigquery.datasets.get",
    "bigquery.tables.get",
    "bigquery.tables.list",
    "bigquery.tables.getData",
    "bigquery.tables.updateData",
  ]
}

locals {
  bq_workloads = {
    live       = google_service_account.live.email
    historical = google_service_account.historical.email
  }
}

resource "google_project_iam_member" "job_user" {
  for_each = local.bq_workloads
  project  = var.project_id
  role     = "roles/bigquery.jobUser"
  member   = "serviceAccount:${each.value}"
}

resource "google_bigquery_dataset_iam_member" "source_reader" {
  for_each   = local.bq_workloads
  project    = var.project_id
  dataset_id = var.source_dataset
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${each.value}"
}

resource "google_bigquery_dataset_iam_member" "config_reader" {
  for_each   = local.bq_workloads
  project    = var.project_id
  dataset_id = google_bigquery_dataset.config.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${each.value}"
}

resource "google_bigquery_dataset_iam_member" "analytics_writer" {
  for_each   = local.bq_workloads
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = google_project_iam_custom_role.result_writer.id
  member     = "serviceAccount:${each.value}"
}

# Live worker creates tasks that call itself with the invoker identity.
resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.live_eval.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.live.email}"
}

resource "google_service_account_iam_member" "live_acts_as_tasks_invoker" {
  service_account_id = google_service_account.tasks_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.live.email}"
}

resource "google_cloud_run_v2_service_iam_member" "live_invokers" {
  for_each = local.live_enabled ? {
    tasks  = google_service_account.tasks_invoker.email
    pubsub = google_service_account.pubsub_push.email
  } : {}
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.live[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# Pub/Sub service agent: mint OIDC tokens for the push identity, move undeliverable messages to the DLQ.
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}

resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.session_updates_dlq.name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "source_subscriber" {
  count        = local.live_enabled ? 1 : 0
  project      = var.project_id
  subscription = google_pubsub_subscription.live_push[0].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

resource "google_secret_manager_secret_iam_member" "openai_key_access" {
  for_each  = var.attach_openai_secret ? local.bq_workloads : {}
  project   = var.project_id
  secret_id = google_secret_manager_secret.openai_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

# ---- OPTIONAL admin console: the Apps Script runs as its deployer, so the deployer needs exactly these grants ----
# Everything here is off unless enable_admin_console = true; nothing in the engine depends on it.
locals {
  console_members = var.enable_admin_console ? toset(var.console_members) : toset([])
}

resource "google_project_iam_custom_role" "console_config_editor" {
  count       = var.enable_admin_console && length(var.console_members) > 0 ? 1 : 0
  project     = var.project_id
  role_id     = "sciConsoleConfigEditor"
  title       = "SCI console config editor"
  description = "Read and modify rows of the configuration tables; no DDL."
  permissions = [
    "bigquery.datasets.get",
    "bigquery.tables.get",
    "bigquery.tables.list",
    "bigquery.tables.getData",
    "bigquery.tables.updateData",
  ]
}

resource "google_project_iam_member" "console_job_user" {
  for_each = local.console_members
  project  = var.project_id
  role     = "roles/bigquery.jobUser"
  member   = each.value
}

resource "google_bigquery_dataset_iam_member" "console_config_editor" {
  for_each   = local.console_members
  project    = var.project_id
  dataset_id = google_bigquery_dataset.config.dataset_id
  role       = google_project_iam_custom_role.console_config_editor[0].id
  member     = each.value
}

resource "google_bigquery_dataset_iam_member" "console_analytics_reader" {
  for_each   = local.console_members
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = each.value
}

resource "google_bigquery_dataset_iam_member" "console_source_reader" {
  for_each   = local.console_members
  project    = var.project_id
  dataset_id = var.source_dataset
  role       = "roles/bigquery.dataViewer"
  member     = each.value
}
