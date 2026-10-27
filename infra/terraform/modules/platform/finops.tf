# Budgets ALERT; they do not stop spending. Hard controls are: max instances, task rate limits, per-run cost caps,
# AI_ENABLED, per-query max_bytes_billed, and the BigQuery daily quota (manual step, see docs/operations.md:
# the quota-override resource is google-beta only).
resource "google_billing_budget" "monthly" {
  count           = local.budget_enabled ? 1 : 0
  billing_account = var.billing_account
  display_name    = "${local.prefix} monthly"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(floor(var.budget_amount))
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  lifecycle {
    precondition {
      condition     = var.budget_amount > 0
      error_message = "budget_amount must be > 0 when billing_account is set."
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_monitoring_notification_channel" "email" {
  count        = local.alerts_enabled ? 1 : 0
  project      = var.project_id
  display_name = "${local.prefix} alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "oldest_unacked" {
  count                 = local.alerts_enabled && local.live_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "${local.prefix} live backlog age > 10 min"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]

  conditions {
    display_name = "oldest unacked message age"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"${google_pubsub_subscription.live_push[0].name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 600
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "dead_letters" {
  count                 = local.alerts_enabled && local.live_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "${local.prefix} dead-lettered events"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]

  conditions {
    display_name = "messages waiting in DLQ"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"${google_pubsub_subscription.dlq.name}\""
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
