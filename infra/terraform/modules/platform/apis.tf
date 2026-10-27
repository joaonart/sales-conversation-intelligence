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
    ],
    local.budget_enabled ? ["billingbudgets.googleapis.com"] : [],
  ))
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
