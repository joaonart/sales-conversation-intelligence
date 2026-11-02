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

  executor_image                = var.executor_image
  executor_tenants              = var.executor_tenants
  executor_ai_enabled           = var.executor_ai_enabled
  executor_attach_openai_secret = var.executor_attach_openai_secret
  executor_routes_json          = var.executor_routes_json
  executor_schedule             = var.executor_schedule
  executor_monthly_budget_usd   = var.executor_monthly_budget_usd
  executor_max_cost_ceiling     = var.executor_max_cost_ceiling
  executor_max_sessions_ceiling = var.executor_max_sessions_ceiling
  executor_limit                = var.executor_limit

  live_ai_enabled         = var.live_ai_enabled
  live_provider           = var.live_provider
  live_model              = var.live_model
  live_monthly_budget_usd = var.live_monthly_budget_usd

  ingest_image     = var.ingest_image
  ingest_tenants   = var.ingest_tenants
  producer_members = var.producer_members

  github_repository    = var.github_repository
  github_repository_id = var.github_repository_id
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

output "executor" {
  value = module.platform.executor
}

output "github_actions" {
  value = module.platform.github_actions
}

output "ingest" {
  value = module.platform.ingest
}

