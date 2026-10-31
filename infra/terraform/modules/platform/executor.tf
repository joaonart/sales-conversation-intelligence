# Console executor: a Cloud Run Job that polls run_requests, runs the requests an ADMIN approved in the console and exits.
# No server, nothing listens, scale is one task; it exists only when executor_image is set. Spending needs, in order:
#   1. a request made in the console with a cost ceiling (the first gate),
#   2. executor_ai_enabled = true (the second gate) and the OpenAI key secret attached,
#   3. a trigger: by hand (gcloud run jobs execute) or Cloud Scheduler when executor_schedule is set.
# The executor re-validates every request, checks that the requester is still an ADMIN and preflights against the requester's ceiling.
locals {
  executor_args = concat(
    ["once", "--project", var.project_id, "--location", var.bq_location,
    "--source-dataset", var.source_dataset, "--config-dataset", var.config_dataset, "--analytics-dataset", var.analytics_dataset],
    flatten([for t in var.executor_tenants : ["--tenant", t]]),
    ["--limit", tostring(var.executor_limit), "--max-cost-ceiling", tostring(var.executor_max_cost_ceiling),
      "--max-sessions-ceiling", tostring(var.executor_max_sessions_ceiling), "--provider", var.executor_provider,
    "--input-price-per-million", tostring(var.executor_input_price_per_million), "--output-price-per-million", tostring(var.executor_output_price_per_million)],
    var.executor_provider == "responses" ? ["--responses-model", var.executor_responses_model] : [],
  )
  executor_env = merge(local.common_env, { AI_ENABLED = tostring(var.executor_ai_enabled) })
}

resource "google_service_account" "executor" {
  count        = local.executor_on ? 1 : 0
  project      = var.project_id
  account_id   = "${local.prefix}-exec"
  display_name = "SCI console executor (${var.env})"
}

resource "google_project_iam_member" "executor_job_user" {
  count   = local.executor_on ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.executor[0].email}"
}

resource "google_bigquery_dataset_iam_member" "executor_source_reader" {
  count      = local.executor_on ? 1 : 0
  project    = var.project_id
  dataset_id = var.source_dataset
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.executor[0].email}"
}

# Reads rubrics, policies and the console's users and requests ...
resource "google_bigquery_dataset_iam_member" "executor_config_reader" {
  count      = local.executor_on ? 1 : 0
  project    = var.project_id
  dataset_id = google_bigquery_dataset.config.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.executor[0].email}"
}

# ... and may append to exactly ONE configuration table: the request queue (state changes are new rows). It cannot touch rubrics or users.
resource "google_bigquery_table_iam_member" "executor_requests_writer" {
  count      = local.executor_on ? 1 : 0
  project    = var.project_id
  dataset_id = google_bigquery_dataset.config.dataset_id
  table_id   = google_bigquery_table.tables["run_requests"].table_id
  role       = google_project_iam_custom_role.result_writer.id
  member     = "serviceAccount:${google_service_account.executor[0].email}"
}

resource "google_bigquery_dataset_iam_member" "executor_analytics_writer" {
  count      = local.executor_on ? 1 : 0
  project    = var.project_id
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = google_project_iam_custom_role.result_writer.id
  member     = "serviceAccount:${google_service_account.executor[0].email}"
}

resource "google_secret_manager_secret_iam_member" "executor_openai_key" {
  count     = local.executor_on && var.executor_attach_openai_secret ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.openai_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.executor[0].email}"
}

resource "google_cloud_run_v2_job" "executor" {
  count               = local.executor_on ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${local.prefix}-executor"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    parallelism = 1
    task_count  = 1
    template {
      service_account = google_service_account.executor[0].email
      timeout         = "${var.executor_timeout_seconds}s"
      max_retries     = 0 # a failed run is reported, not repeated: a request is claimed once and every job is idempotent anyway
      containers {
        image = var.executor_image
        args  = local.executor_args
        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
        dynamic "env" {
          for_each = local.executor_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = var.executor_routes_json != "" ? [1] : []
          content {
            name  = "SCI_ROUTES_JSON"
            value = var.executor_routes_json
          }
        }
        dynamic "env" {
          for_each = var.executor_attach_openai_secret ? [1] : []
          content {
            name = "OPENAI_API_KEY"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.openai_key.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = length(var.executor_tenants) > 0
      error_message = "Name at least one organization/workspace in executor_tenants: an executor that serves nobody has no purpose."
    }
    precondition {
      condition     = var.executor_provider != "responses" || var.executor_responses_model != ""
      error_message = "executor_provider = responses needs executor_responses_model (never defaulted)."
    }
  }
  depends_on = [google_project_service.apis]
}

# ---- optional trigger: Cloud Scheduler calls the Cloud Run Admin API with its own identity (no keys, no public endpoint) ----
resource "google_service_account" "executor_scheduler" {
  count        = local.executor_scheduled ? 1 : 0
  project      = var.project_id
  account_id   = "${local.prefix}-exec-sched"
  display_name = "Cloud Scheduler -> console executor (${var.env})"
}

resource "google_cloud_run_v2_job_iam_member" "executor_scheduler_invoker" {
  count    = local.executor_scheduled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.executor[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.executor_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "executor" {
  count            = local.executor_scheduled ? 1 : 0
  project          = var.project_id
  region           = var.region
  name             = "${local.prefix}-executor-poll"
  description      = "Looks for execution requests approved in the console. Idle polls are quiet and free."
  schedule         = var.executor_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.executor[0].name}:run"
    oauth_token {
      service_account_email = google_service_account.executor_scheduler[0].email
    }
  }
  depends_on = [google_project_service.apis]
}
