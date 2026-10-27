locals {
  common_env = {
    GCP_PROJECT       = var.project_id
    BQ_LOCATION       = var.bq_location
    REGION            = var.region
    SOURCE_DATASET    = var.source_dataset
    CONFIG_DATASET    = var.config_dataset
    ANALYTICS_DATASET = var.analytics_dataset
    AI_ENABLED        = tostring(var.ai_enabled)
  }
  live_env = merge(local.common_env, {
    SERVICE_URL      = local.live_url
    SCI_TENANTS      = var.tenants_json
    TASKS_QUEUE      = google_cloud_tasks_queue.live_eval.name
    TASKS_INVOKER_SA = google_service_account.tasks_invoker.email
    PUBSUB_PUSH_SA   = google_service_account.pubsub_push.email
  })
}

resource "google_cloud_run_v2_service" "live" {
  count               = local.live_enabled ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = local.live_name
  ingress             = var.live_ingress
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account                  = google_service_account.live.email
    timeout                          = "300s"
    max_instance_request_concurrency = 8
    scaling {
      min_instance_count = 0 # scale to zero: no idle spend
      max_instance_count = var.live_max_instances
    }
    containers {
      image   = var.live_image
      command = ["python", "-m", "sci_workers.live_main"]
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.live_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.attach_openai_secret ? [1] : []
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
  depends_on = [google_project_service.apis]
}

# Authenticated callers only; there is no allUsers binding anywhere in this module.
resource "google_cloud_run_v2_service" "api" {
  count               = local.api_enabled ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${local.prefix}-api"
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = var.api_max_instances
    }
    containers {
      image = var.api_image
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Executed manually (`gcloud run jobs execute ... --args`) after preflight approval; no scheduler.
resource "google_cloud_run_v2_job" "historical" {
  count               = local.historical_on ? 1 : 0
  project             = var.project_id
  location            = var.region
  name                = "${local.prefix}-historical"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    parallelism = 1
    task_count  = 1
    template {
      service_account = google_service_account.historical.email
      timeout         = "${var.job_timeout_seconds}s"
      max_retries     = var.job_max_retries
      containers {
        image = var.historical_image
        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = var.attach_openai_secret ? [1] : []
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
  depends_on = [google_project_service.apis]
}
