resource "google_project_service" "apis" {
  for_each = toset(["run.googleapis.com", "bigquery.googleapis.com", "pubsub.googleapis.com", "cloudscheduler.googleapis.com", "secretmanager.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com"])
  project = var.project_id
  service = each.value
  disable_on_destroy = false
}

resource "google_bigquery_dataset" "datasets" {
  for_each = toset(["conversation_config", "conversation_analytics"])
  project = var.project_id
  dataset_id = "${var.prefix}_${each.value}"
  location = var.bq_location
  delete_contents_on_destroy = false
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "session_updates" {
  project = var.project_id
  name = "${var.prefix}-session-updates"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "session_updates" {
  project = var.project_id
  name = "${var.prefix}-session-updates-worker"
  topic = google_pubsub_topic.session_updates.id
  ack_deadline_seconds = 60
  message_retention_duration = "604800s"
}

resource "google_service_account" "api" {
  project = var.project_id
  account_id = "${var.prefix}-api"
  display_name = "SCI API"
}
resource "google_service_account" "worker" {
  project = var.project_id
  account_id = "${var.prefix}-worker"
  display_name = "SCI Worker"
}
