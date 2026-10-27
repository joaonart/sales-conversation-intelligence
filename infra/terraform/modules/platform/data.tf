# Dataset ids carry no env prefix: dev and prod live in separate projects, and BigQuery ids cannot contain hyphens.
resource "google_bigquery_dataset" "config" {
  project                    = var.project_id
  dataset_id                 = var.config_dataset
  location                   = var.bq_location
  delete_contents_on_destroy = false
  max_time_travel_hours      = 48 # minimum; shorter time travel reduces storage cost
  labels                     = local.labels
  depends_on                 = [google_project_service.apis]
}

resource "google_bigquery_dataset" "analytics" {
  project                    = var.project_id
  dataset_id                 = var.analytics_dataset
  location                   = var.bq_location
  delete_contents_on_destroy = false
  max_time_travel_hours      = 48
  labels                     = local.labels
  depends_on                 = [google_project_service.apis]
}

locals {
  partitions = {
    session_analyses          = "started_at"
    session_criterion_results = "evaluated_at"
    analysis_runs             = "created_at"
  }
  clustering = {
    evaluation_rubrics        = ["organization_id", "workspace_id", "rubric_id"]
    evaluation_criteria       = ["organization_id", "workspace_id", "rubric_id"]
    evaluation_policies       = ["organization_id", "workspace_id", "rubric_id"]
    session_analyses          = ["organization_id", "workspace_id", "session_id", "rubric_id"]
    session_criterion_results = ["organization_id", "workspace_id", "session_id"]
    analysis_runs             = ["organization_id", "workspace_id"]
  }
}

# Schemas are generated from sql/*.sql; tests/test_terraform_schemas.py fails on drift.
resource "google_bigquery_table" "tables" {
  for_each            = toset(local.tables)
  project             = var.project_id
  dataset_id          = contains(local.config_tables, each.value) ? google_bigquery_dataset.config.dataset_id : google_bigquery_dataset.analytics.dataset_id
  table_id            = each.value
  schema              = file("${path.module}/schemas/${each.value}.json")
  clustering          = local.clustering[each.value]
  deletion_protection = var.deletion_protection
  labels              = local.labels

  dynamic "time_partitioning" {
    for_each = contains(keys(local.partitions), each.value) ? [local.partitions[each.value]] : []
    content {
      type  = "DAY"
      field = time_partitioning.value
    }
  }
}

resource "google_bigquery_table" "latest_session_analyses" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "latest_session_analyses"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  view {
    use_legacy_sql = false
    query = templatefile("${path.module}/views/latest_session_analyses.sql", {
      project = var.project_id
      dataset = var.analytics_dataset
    })
  }
  depends_on = [google_bigquery_table.tables]
}
