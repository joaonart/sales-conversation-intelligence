# The identity of the system that SENDS conversations (the producer): a service account that may publish to the conversations topic and do nothing
# else. It cannot read BigQuery, see results, or touch any other resource. The producer authenticates as it with a key that a person creates out of
# band (see docs/producer-guide.md); Terraform never creates or holds that key, so it is never in the state. Nothing here exists until
# `producer_service_account` is true.
locals {
  producer_on = var.producer_service_account && local.ingest_on
}

resource "google_service_account" "producer" {
  count        = local.producer_on ? 1 : 0
  project      = var.project_id
  account_id   = "${local.prefix}-producer"
  display_name = "Conversation producer (${var.env})"
}

resource "google_pubsub_topic_iam_member" "producer_publishes" {
  count   = local.producer_on ? 1 : 0
  project = var.project_id
  topic   = google_pubsub_topic.conversations[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.producer[0].email}"
}
