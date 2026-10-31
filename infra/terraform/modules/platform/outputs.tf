output "dataset_ids" {
  value = {
    config    = google_bigquery_dataset.config.dataset_id
    analytics = google_bigquery_dataset.analytics.dataset_id
  }
}

output "session_updates_topic" {
  description = "Topic the upstream ingestion pipeline publishes session-update events to."
  value       = google_pubsub_topic.session_updates.id
}

output "service_accounts" {
  value = {
    api           = google_service_account.api.email
    live          = google_service_account.live.email
    historical    = google_service_account.historical.email
    tasks_invoker = google_service_account.tasks_invoker.email
    pubsub_push   = google_service_account.pubsub_push.email
  }
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "openai_secret_id" {
  description = "Add the key out-of-band: gcloud secrets versions add <id> --data-file=-"
  value       = google_secret_manager_secret.openai_key.secret_id
}

output "live_url" {
  value = local.live_enabled ? local.live_url : null
}

output "executor" {
  description = "Console executor: job name, identity and how to run it by hand (null while no image is set)."
  value = local.executor_on ? {
    job             = google_cloud_run_v2_job.executor[0].name
    service_account = google_service_account.executor[0].email
    run             = "gcloud run jobs execute ${google_cloud_run_v2_job.executor[0].name} --region ${var.region} --project ${var.project_id}"
    scheduled       = local.executor_scheduled
  } : null
}
