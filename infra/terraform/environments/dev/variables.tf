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
