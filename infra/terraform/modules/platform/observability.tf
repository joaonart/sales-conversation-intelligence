# Log-based metrics read the metadata-only JSON lines emitted by sci_core.obs (see tests/test_terraform_static.py,
# which keeps these field names in sync with the code). They never see chat content because none is logged.
locals {
  run_logs = "(resource.type=\"cloud_run_revision\" OR resource.type=\"cloud_run_job\") AND jsonPayload.logger:\"sci.\""
}

resource "google_logging_metric" "evaluations" {
  project = var.project_id
  name    = "${local.prefix}_evaluations"
  filter  = "${local.run_logs} AND jsonPayload.event=\"evaluation\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "outcome"
      value_type = "STRING"
    }
    labels {
      key        = "mode"
      value_type = "STRING"
    }
  }
  label_extractors = {
    outcome = "EXTRACT(jsonPayload.outcome)"
    mode    = "EXTRACT(jsonPayload.mode)"
  }
  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "evaluation_latency" {
  project         = var.project_id
  name            = "${local.prefix}_evaluation_latency_ms"
  filter          = "${local.run_logs} AND jsonPayload.event=\"evaluation\""
  value_extractor = "EXTRACT(jsonPayload.latency_ms)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 100
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "failures" {
  project = var.project_id
  name    = "${local.prefix}_failures"
  filter  = "${local.run_logs} AND (jsonPayload.event=\"session_failed\" OR jsonPayload.event=\"task_retry\" OR jsonPayload.event=\"malformed_event\")"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "event"
      value_type = "STRING"
    }
    labels {
      key        = "error_type"
      value_type = "STRING"
    }
  }
  label_extractors = {
    event      = "EXTRACT(jsonPayload.event)"
    error_type = "EXTRACT(jsonPayload.error_type)"
  }
  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "failure_rate" {
  count                 = local.alerts_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "${local.prefix} failures > 10 in 10 min"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]

  conditions {
    display_name = "failed sessions / retried tasks / malformed events"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.failures.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "latency_p95" {
  count                 = local.alerts_enabled ? 1 : 0
  project               = var.project_id
  display_name          = "${local.prefix} p95 analysis latency > 120 s"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].id]

  conditions {
    display_name = "p95 evaluation latency (SLO: 95% under 120 s)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.evaluation_latency.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 120000
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
    }
  }
}
