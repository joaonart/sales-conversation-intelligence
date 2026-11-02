variable "project_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "region" {
  type = string
}

variable "bq_location" {
  type = string
}

variable "api_image" {
  type    = string
  default = ""
}

variable "live_image" {
  type    = string
  default = ""
}

variable "historical_image" {
  type    = string
  default = ""
}

variable "ai_enabled" {
  type    = bool
  default = false
}

variable "tenants_json" {
  type    = string
  default = "[]"
}

variable "attach_openai_secret" {
  type    = bool
  default = false
}

variable "billing_account" {
  type    = string
  default = ""
}

variable "budget_amount" {
  type    = number
  default = 0
}

variable "alert_email" {
  type    = string
  default = ""
}

variable "budget_currency" {
  type        = string
  default     = "USD"
  description = "Must match the billing account currency."
}

variable "enable_admin_console" {
  type        = bool
  default     = false
  description = "OPTIONAL admin console tables and deployer grants. The platform works without it."
}

variable "console_members" {
  type        = list(string)
  default     = []
  description = "Deployers of the admin console, e.g. [\"user:person@example.com\"]."
}

# ---- console executor (all off by default; see docs/deployment-plan.md) ----
variable "executor_image" {
  type    = string
  default = ""
}

variable "executor_tenants" {
  type    = list(string)
  default = []
}

variable "executor_ai_enabled" {
  type    = bool
  default = false
}

variable "executor_attach_openai_secret" {
  type    = bool
  default = false
}

variable "executor_routes_json" {
  type    = string
  default = ""
}

variable "executor_monthly_budget_usd" {
  type    = number
  default = 0
}

variable "executor_max_cost_ceiling" {
  type    = number
  default = 1
}

variable "executor_max_sessions_ceiling" {
  type    = number
  default = 1000
}

variable "executor_limit" {
  type    = number
  default = 3
}

variable "executor_schedule" {
  type    = string
  default = ""
}

# ---- GitHub Actions federation (off by default) ----
variable "github_repository" {
  type    = string
  default = ""
}

variable "github_repository_id" {
  type    = string
  default = ""
}

# ---- live worker AI (off by default) ----
variable "live_ai_enabled" {
  type    = bool
  default = false
}

variable "live_provider" {
  type    = string
  default = "decisions"
}

variable "live_model" {
  type    = string
  default = ""
}

variable "live_monthly_budget_usd" {
  type    = number
  default = 0
}

# ---- conversation ingest (off by default) ----
variable "ingest_image" {
  type    = string
  default = ""
}

variable "ingest_tenants" {
  type    = list(string)
  default = []
}

variable "producer_service_account" {
  type    = bool
  default = false
}

variable "producer_members" {
  type    = list(string)
  default = []
}

