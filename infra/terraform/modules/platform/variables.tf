variable "project_id" {
  description = "GCP project id (explicit; never inferred from ambient config)."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id."
  }
}

variable "project_number" {
  description = "Numeric project number (service agents, budget filter and the deterministic Cloud Run URL)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{6,}$", var.project_number))
    error_message = "project_number must be numeric."
  }
}

variable "region" {
  description = "Region for Cloud Run, Cloud Tasks, Artifact Registry and secret replicas. Choose for data residency/LGPD."
  type        = string
}

variable "bq_location" {
  description = "BigQuery dataset location. Must match the existing source dataset's location."
  type        = string
}

variable "env" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env must be dev or prod."
  }
}

variable "name_prefix" {
  type    = string
  default = "sci"
}

variable "source_dataset" {
  description = "Existing dataset exposing the canonical sessions/messages views. Not created or modified here."
  type        = string
  default     = "commerce"
}

variable "config_dataset" {
  type    = string
  default = "conversation_config"
}

variable "analytics_dataset" {
  type    = string
  default = "conversation_analytics"
}

variable "deletion_protection" {
  description = "Protect tables, Cloud Run resources and datasets from accidental deletion."
  type        = bool
  default     = true
}

# ---- runtime (nothing paid is created until an image is provided) ----
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
  description = "Exposed to workers as AI_ENABLED. Keep false until the deployment plan is approved."
  type        = bool
  default     = false
}

variable "tenants_json" {
  description = "Live tenant allowlist (SCI_TENANTS). Example: [{\"organization_id\":\"o\",\"workspace_id\":\"w\",\"rubric_id\":\"r\"}]"
  type        = string
  default     = "[]"
}

variable "live_max_instances" {
  type    = number
  default = 3
}

variable "api_max_instances" {
  type    = number
  default = 2
}

variable "live_ingress" {
  description = "INGRESS_TRAFFIC_ALL (IAM still required) or INGRESS_TRAFFIC_INTERNAL_ONLY (Pub/Sub and Cloud Tasks still reach it)."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}

variable "job_timeout_seconds" {
  type    = number
  default = 3600
}

variable "job_max_retries" {
  type    = number
  default = 1
}

variable "attach_openai_secret" {
  description = "Mount the OpenAI key secret into the workers. Requires a secret version to exist. Leave false until approved."
  type        = bool
  default     = false
}

# ---- messaging ----
variable "tasks_max_dispatches_per_second" {
  type    = number
  default = 5
}

variable "tasks_max_concurrent" {
  type    = number
  default = 5
}

variable "push_max_delivery_attempts" {
  type    = number
  default = 5
}

# ---- finops ----
variable "billing_account" {
  description = "Billing account id for the budget (empty = no budget resource). Budgets alert; they do NOT cap spend."
  type        = string
  default     = ""
}

variable "budget_amount" {
  description = "Monthly budget in budget_currency. Required when billing_account is set."
  type        = number
  default     = 0
}

variable "budget_currency" {
  type    = string
  default = "USD"
}

variable "alert_email" {
  description = "Email for monitoring alerts (empty = no notification channel/alert policies)."
  type        = string
  default     = ""
}

# ---- admin console (OPTIONAL Apps Script web app; the engine never depends on it) ----
variable "enable_admin_console" {
  description = "Create the console-only tables (app_users, audit_log) and the deployer grants. Off by default: the platform works without the console."
  type        = bool
  default     = false
}

variable "console_members" {
  description = "IAM members (e.g. user:person@example.com) that deploy the admin console. Empty = no console grants."
  type        = list(string)
  default     = []

  validation {
    condition     = var.enable_admin_console || length(var.console_members) == 0
    error_message = "console_members is set but enable_admin_console is false. Enable the console or clear console_members."
  }
}
