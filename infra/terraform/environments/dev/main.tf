terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" { project = var.project_id, region = var.region }
module "foundation" {
  source = "../../modules/foundation"
  project_id = var.project_id
  region = var.region
  bq_location = var.bq_location
  prefix = var.prefix
}
output "dataset_ids" { value = module.foundation.dataset_ids }
output "session_updates_topic" { value = module.foundation.topic_id }
