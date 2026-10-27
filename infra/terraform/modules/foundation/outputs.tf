output "dataset_ids" { value = { for k, v in google_bigquery_dataset.datasets : k => v.dataset_id } }
output "topic_id" { value = google_pubsub_topic.session_updates.id }
output "api_service_account" { value = google_service_account.api.email }
output "worker_service_account" { value = google_service_account.worker.email }
