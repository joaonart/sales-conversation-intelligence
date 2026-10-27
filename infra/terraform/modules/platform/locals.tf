locals {
  labels = {
    app = "sales-conversation-intelligence"
    env = var.env
  }
  prefix           = "${var.name_prefix}-${var.env}"
  live_enabled     = var.live_image != ""
  historical_on    = var.historical_image != ""
  api_enabled      = var.api_image != ""
  budget_enabled   = var.billing_account != ""
  alerts_enabled   = var.alert_email != ""
  live_name        = "${local.prefix}-live"
  live_url         = "https://${local.live_name}-${var.project_number}.${var.region}.run.app"
  pubsub_agent     = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
  tables           = ["evaluation_rubrics", "evaluation_criteria", "evaluation_policies", "session_analyses", "session_criterion_results", "analysis_runs"]
  config_tables    = ["evaluation_rubrics", "evaluation_criteria", "evaluation_policies"]
  analytics_tables = ["session_analyses", "session_criterion_results", "analysis_runs"]
}
