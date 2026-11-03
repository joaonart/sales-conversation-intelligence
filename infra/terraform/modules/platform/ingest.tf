# Conversation ingest. A producer publishes a conversation (contracts/conversation-event.schema.json) to the topic below, with the Pub/Sub API.
# A push subscription delivers it to a Cloud Run service that validates it, stores it in the canonical BigQuery tables and then publishes the
# analysis event the live worker already consumes. Nothing here exists until `ingest_image` is set; nobody may publish until `producer_members` names them.
resource "google_pubsub_topic" "conversations" {
  count   = local.ingest_on ? 1 : 0
  project = var.project_id
  name    = "${local.prefix}-conversations"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "conversations_dlq" {
  count   = local.ingest_on ? 1 : 0
  project = var.project_id
  name    = "${local.prefix}-conversations-dlq"
  labels  = local.labels

  depends_on = [google_project_service.apis]
}

# Keeps conversations that could not be ingested inspectable and replayable for 7 days.
resource "google_pubsub_subscription" "conversations_dlq_hold" {
  count                      = local.ingest_on ? 1 : 0
  project                    = var.project_id
  name                       = "${local.prefix}-conversations-dlq-hold"
  topic                      = google_pubsub_topic.conversations_dlq[0].id
  message_retention_duration = "604800s"
  ack_deadline_seconds       = 60
  labels                     = local.labels
  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "conversations_ingest" {
  count                      = local.ingest_on ? 1 : 0
  project                    = var.project_id
  name                       = "${local.prefix}-conversations-ingest"
  topic                      = google_pubsub_topic.conversations[0].id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  labels                     = local.labels

  push_config {
    push_endpoint = "${local.ingest_url}/pubsub/push"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = "${local.ingest_url}/pubsub/push"
    }
  }

  # Non-2xx (a BigQuery error, an invalid conversation, a workspace not allowed) is retried with backoff and then parked, never dropped.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.conversations_dlq[0].id
    max_delivery_attempts = var.push_max_delivery_attempts
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "conversations_dlq_publisher" {
  count   = local.ingest_on ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.conversations_dlq[0].name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "conversations_subscriber" {
  count        = local.ingest_on ? 1 : 0
  project      = var.project_id
  subscription = google_pubsub_subscription.conversations_ingest[0].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

# ---- who may publish conversations: exactly the members named, on this topic only ----
resource "google_pubsub_topic_iam_member" "producers" {
  for_each = local.ingest_on ? toset(var.producer_members) : toset([])
  project  = var.project_id
  topic    = google_pubsub_topic.conversations[0].name
  role     = "roles/pubsub.publisher"
  member   = each.value
}

# ---- the service ----
resource "google_service_account" "ingest" {
  count        = local.ingest_on ? 1 : 0
  project      = var.project_id
  account_id   = "${local.prefix}-ingest"
  display_name = "SCI conversation ingest (${var.env})"
}

# Appends versions of sessions and messages and reads the latest version of a session; it cannot read results, change schemas or delete tables.
resource "google_project_iam_custom_role" "source_writer" {
  count       = local.ingest_on ? 1 : 0
  project     = var.project_id
  role_id     = "sciSourceWriter"
  title       = "SCI source writer"
  description = "Insert and merge rows into the canonical source tables; no delete, no schema change."
  permissions = [
    "bigquery.datasets.get",
    "bigquery.tables.get",
    "bigquery.tables.getData",
    "bigquery.tables.updateData",
  ]
}

resource "google_bigquery_dataset_iam_member" "ingest_source_writer" {
  count      = local.ingest_on ? 1 : 0
  project    = var.project_id
  dataset_id = var.source_dataset
  role       = google_project_iam_custom_role.source_writer[0].id
  member     = "serviceAccount:${google_service_account.ingest[0].email}"
}

# bigquery.jobs.create: the lookups of the latest session version and of the stored message ids are query jobs.
resource "google_project_iam_member" "ingest_job_user" {
  count   = local.ingest_on ? 1 : 0
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.ingest[0].email}"
}

# It announces what it stored on the topic the live worker listens to, and on that one only.
resource "google_pubsub_topic_iam_member" "ingest_publishes_events" {
  count   = local.ingest_on ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.session_updates.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.ingest[0].email}"
}

resource "google_cloud_run_v2_service" "ingest" {
  count               = local.ingest_on ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = local.ingest_name
  ingress             = var.live_ingress
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account                  = google_service_account.ingest[0].email
    timeout                          = "120s"
    max_instance_request_concurrency = 8
    scaling {
      min_instance_count = 0 # scale to zero: no idle spend
      max_instance_count = var.ingest_max_instances
    }
    containers {
      image   = var.ingest_image
      command = ["python", "-m", "sci_workers.ingest_main"]
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = {
          GCP_PROJECT    = var.project_id
          BQ_LOCATION    = var.bq_location
          SOURCE_DATASET = var.source_dataset
          SERVICE_URL    = local.ingest_url
          EVENTS_TOPIC   = google_pubsub_topic.session_updates.name
          PUBSUB_PUSH_SA = google_service_account.pubsub_push.email
          INGEST_TENANTS = jsonencode([for t in var.ingest_tenants : { organization_id = split("/", t)[0], workspace_id = split("/", t)[1] }])
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [scaling] # provider quirk: Cloud Run reports a service-level scaling block with defaults
    precondition {
      condition     = length(var.ingest_tenants) > 0
      error_message = "Name at least one organization/workspace in ingest_tenants: an ingest service that accepts nobody has no purpose."
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "ingest_invoker" {
  count    = local.ingest_on ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.ingest[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# Same alarm as for the live events: anything parked in the hold is a conversation that was not stored.
resource "google_monitoring_alert_policy" "conversations_dead_letters" {
  count                 = local.alerts_enabled && local.ingest_on ? 1 : 0
  project               = var.project_id
  display_name          = "${local.prefix} conversations that could not be ingested"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]

  conditions {
    display_name = "conversations waiting in the DLQ"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"${local.prefix}-conversations-dlq-hold\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}
