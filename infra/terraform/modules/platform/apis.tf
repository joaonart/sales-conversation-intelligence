resource "google_project_service" "apis" {
  for_each = toset(concat(
    [
      "bigquery.googleapis.com",
      "run.googleapis.com",
      "pubsub.googleapis.com",
      "cloudtasks.googleapis.com",
      "secretmanager.googleapis.com",
      "artifactregistry.googleapis.com",
      "iam.googleapis.com",
      "logging.googleapis.com",
      "monitoring.googleapis.com",
      "cloudresourcemanager.googleapis.com",
    ],
    local.budget_enabled ? ["billingbudgets.googleapis.com"] : [],
    local.github_on ? ["iamcredentials.googleapis.com", "sts.googleapis.com"] : [],
    local.executor_scheduled ? ["cloudscheduler.googleapis.com"] : [],
  ))
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
