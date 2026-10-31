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
  description = "Create the console-only tables (app_users, audit_log, review_decisions) and the deployer grants. Off by default: the platform works without the console."
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

# ---- console executor (Cloud Run Job that runs the execution requests made in the admin console) ----
# Nothing exists until an image is given. Everything that spends is a separate, explicit switch.
variable "executor_image" {
  description = "Image of apps/console-executor. Empty = no executor. Needs enable_admin_console (the requests live in a console table)."
  type        = string
  default     = ""
  validation {
    condition     = var.executor_image == "" || var.enable_admin_console
    error_message = "The executor reads the console's run_requests table: set enable_admin_console = true."
  }
}

variable "executor_tenants" {
  description = "organization/workspace pairs the executor serves. Requests of any other workspace are ignored."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for t in var.executor_tenants : can(regex("^[^/[:space:]]+/[^/[:space:]]+$", t))])
    error_message = "Use organization/workspace, for example synthetic-a/default."
  }
}

variable "executor_ai_enabled" {
  description = "AI_ENABLED of the executor (the second gate; the first is the request in the console). While false, a waiting request is left untouched and the job ends with a clear refusal."
  type        = bool
  default     = false
}

variable "executor_attach_openai_secret" {
  description = "Mount the OpenAI key secret into the executor. Requires a secret version to exist (added out-of-band)."
  type        = bool
  default     = false
}

variable "executor_provider" {
  type    = string
  default = "decisions"
  validation {
    condition     = contains(["decisions", "responses"], var.executor_provider)
    error_message = "decisions or responses."
  }
}

variable "executor_responses_model" {
  description = "Required with executor_provider = responses. Never defaulted."
  type        = string
  default     = ""
}

variable "executor_input_price_per_million" {
  description = "USD per 1M input tokens used to price the budget gate (from the official pricing page). The default is the validated worst case of gpt-6-luna."
  type        = number
  default     = 0.125
}

variable "executor_output_price_per_million" {
  type    = number
  default = 0.5
}

variable "executor_max_cost_ceiling" {
  description = "A request whose cost ceiling is above this (USD) is refused by the executor."
  type        = number
  default     = 1
}

variable "executor_max_sessions_ceiling" {
  type    = number
  default = 1000
}

variable "executor_limit" {
  description = "Requests taken per execution."
  type        = number
  default     = 3
}

variable "executor_routes_json" {
  description = "Routes for ROUTING requests (see config/routes.sales-and-after-sales.example.json). Empty = routing requests are refused."
  type        = string
  default     = ""
}

variable "executor_timeout_seconds" {
  type    = number
  default = 900
}

variable "executor_schedule" {
  description = "Cron (UTC) for Cloud Scheduler to run the executor, for example */5 * * * *. Empty = no scheduler: run it by hand with gcloud run jobs execute."
  type        = string
  default     = ""
}

# ---- GitHub Actions -> GCP without keys (Workload Identity Federation), used to build and push images ----
variable "github_repository" {
  description = "owner/name of the GitHub repository allowed to push images. Empty = no federation is created."
  type        = string
  default     = ""
  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "Use owner/name."
  }
}

variable "github_repository_id" {
  description = "Numeric repository id (gh api repos/<owner>/<name> --jq .id). The token is accepted only for this id, so a renamed or recreated repository with the same name is not trusted."
  type        = string
  default     = ""
  validation {
    condition     = var.github_repository == "" || can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric id when github_repository is set."
  }
}

variable "github_ref" {
  description = "Only workflows running on this ref can obtain a token."
  type        = string
  default     = "refs/heads/main"
}
