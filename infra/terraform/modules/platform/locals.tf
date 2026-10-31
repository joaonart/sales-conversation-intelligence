locals {
  labels = {
    app = "sales-conversation-intelligence"
    env = var.env
  }
  prefix             = "${var.name_prefix}-${var.env}"
  live_enabled       = var.live_image != ""
  historical_on      = var.historical_image != ""
  api_enabled        = var.api_image != ""
  github_on          = var.github_repository != ""
  executor_on        = var.executor_image != ""
  executor_scheduled = var.executor_image != "" && var.executor_schedule != ""
  budget_enabled     = var.billing_account != ""
  alerts_enabled     = var.alert_email != ""
  live_name          = "${local.prefix}-live"
  live_url           = "https://${local.live_name}-${var.project_number}.${var.region}.run.app"
  pubsub_agent       = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
  core_config_tables = ["evaluation_rubrics", "evaluation_criteria", "evaluation_policies"]
  console_tables     = var.enable_admin_console ? ["app_users", "audit_log", "review_decisions", "run_requests"] : []
  config_tables      = concat(local.core_config_tables, local.console_tables)
  analytics_tables   = ["session_analyses", "session_criterion_results", "analysis_runs", "session_routes", "run_failures"]
  tables             = concat(local.config_tables, local.analytics_tables)
}
