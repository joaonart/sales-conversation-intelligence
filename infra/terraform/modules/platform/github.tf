# GitHub Actions authenticates with a short-lived OIDC token, never a key. The token is accepted only from ONE repository (matched by its numeric id)
# running on ONE ref, and the identity it becomes can only push images to this project's repository: it cannot deploy, read data or change anything else.
# Pushing an image does not deploy it; Cloud Run changes only through an approved terraform apply.
resource "google_service_account" "build" {
  count        = local.github_on ? 1 : 0
  project      = var.project_id
  account_id   = "${local.prefix}-build"
  display_name = "GitHub Actions image build (${var.env})"
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = local.github_on ? 1 : 0
  project                   = var.project_id
  workload_identity_pool_id = "${local.prefix}-github"
  display_name              = "GitHub Actions (${var.env})"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = local.github_on ? 1 : 0
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
  }
  # Public repository: without this condition any GitHub workflow in the world could present a valid token. Both must hold.
  attribute_condition = "assertion.repository_id == '${var.github_repository_id}' && assertion.ref == '${var.github_ref}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonates_build" {
  count              = local.github_on ? 1 : 0
  service_account_id = google_service_account.build[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository_id/${var.github_repository_id}"
}

# Write access to the image repository only (not project-wide).
resource "google_artifact_registry_repository_iam_member" "build_pushes_images" {
  count      = local.github_on ? 1 : 0
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build[0].email}"
}
