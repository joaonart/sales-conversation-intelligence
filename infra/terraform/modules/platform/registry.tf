resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "${local.prefix}-images"
  format        = "DOCKER"
  labels        = local.labels

  # Untagged and old images are deleted to keep storage cost near zero.
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }
  depends_on = [google_project_service.apis]
}

# The OpenAI key is created empty: its value is added out-of-band (never in Terraform state or Git).
resource "google_secret_manager_secret" "openai_key" {
  project   = var.project_id
  secret_id = "${local.prefix}-openai-api-key"
  labels    = local.labels
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
  depends_on = [google_project_service.apis]
}
