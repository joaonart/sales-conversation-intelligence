resource "google_pubsub_topic" "session_updates" {
  project = var.project_id
  name    = "${local.prefix}-session-updates"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "session_updates_dlq" {
  project = var.project_id
  name    = "${local.prefix}-session-updates-dlq"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

# Keeps dead-lettered events inspectable and replayable for 7 days.
resource "google_pubsub_subscription" "dlq" {
  project                    = var.project_id
  name                       = "${local.prefix}-session-updates-dlq-hold"
  topic                      = google_pubsub_topic.session_updates_dlq.id
  message_retention_duration = "604800s"
  ack_deadline_seconds       = 60
  labels                     = local.labels
  expiration_policy {
    ttl = ""
  }
}

# Push subscription exists only once the live worker image is provided (no consumer -> nothing to deliver to).
resource "google_pubsub_subscription" "live_push" {
  count                      = local.live_enabled ? 1 : 0
  project                    = var.project_id
  name                       = "${local.prefix}-session-updates-live"
  topic                      = google_pubsub_topic.session_updates.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  labels                     = local.labels

  push_config {
    push_endpoint = "${local.live_url}/pubsub/push"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = "${local.live_url}/pubsub/push"
    }
  }

  # Non-2xx (including 503 when AI is disabled) is retried with backoff; the backlog is retained, never dropped.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.session_updates_dlq.id
    max_delivery_attempts = var.push_max_delivery_attempts
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_cloud_tasks_queue" "live_eval" {
  project  = var.project_id
  location = var.region
  name     = "${local.prefix}-live-eval"

  rate_limits {
    max_dispatches_per_second = var.tasks_max_dispatches_per_second
    max_concurrent_dispatches = var.tasks_max_concurrent
  }

  retry_config {
    max_attempts       = 8
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}
