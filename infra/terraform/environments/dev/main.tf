terraform {
  required_version = ">= 1.9.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

# Project and region are always explicit: no ambient gcloud configuration is used.
provider "google" {
  project = var.project_id
  region  = var.region

  # User credentials (ADC) need a quota project for billingbudgets.googleapis.com.
  user_project_override = true
  billing_project       = var.project_id
}

module "platform" {
  source = "../../modules/platform"

  env                  = "dev"
  project_id           = var.project_id
  project_number       = var.project_number
  region               = var.region
  bq_location          = var.bq_location
  deletion_protection  = false
  live_ingress         = "INGRESS_TRAFFIC_ALL"
  api_image            = var.api_image
  live_image           = var.live_image
  historical_image     = var.historical_image
  ai_enabled           = var.ai_enabled
  tenants_json         = var.tenants_json
  attach_openai_secret = var.attach_openai_secret
  billing_account      = var.billing_account
  budget_amount        = var.budget_amount
  enable_admin_console = var.enable_admin_console
  console_members      = var.console_members
  budget_currency      = var.budget_currency
  alert_email          = var.alert_email
}

output "dataset_ids" {
  value = module.platform.dataset_ids
}

output "session_updates_topic" {
  value = module.platform.session_updates_topic
}

output "service_accounts" {
  value = module.platform.service_accounts
}

output "image_repository" {
  value = module.platform.image_repository
}

output "openai_secret_id" {
  value = module.platform.openai_secret_id
}
