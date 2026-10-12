variable "account_id" {

  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Bind a 12-digit AWS account ID."
  }

}
variable "ami_id" {
  type = string
}
variable "instance_type" {
  type    = string
  default = "t3a.large"
}
variable "allowed_web_cidr" {
  type = string
  validation {
    condition     = can(cidrhost(var.allowed_web_cidr, 0)) && var.allowed_web_cidr != "0.0.0.0/0"
    error_message = "Use an explicitly authorized restricted web CIDR for initial staging."
  }

}
variable "github_oidc_provider_arn" {
  type = string
}
variable "github_build_sub" {
  type    = string
  default = "repo:hunter875/edumatch-production:environment:aws-staging-build"
}
variable "github_deploy_sub" {
  type    = string
  default = "repo:hunter875/edumatch-production:environment:aws-staging"
}
variable "oidc_claims_verified" {
  type    = bool
  default = false
}

# Deployment mode selects which authorization gate protects the staging
# instance. "manual" is the operator-driven path (temporary AWS session plus
# SSM); it still requires the caller to prove the target account. "github"
# is the CI path and additionally requires a verified GitHub OIDC claim.
variable "deployment_mode" {
  type    = string
  default = "manual"
  validation {
    condition     = contains(["manual", "github"], var.deployment_mode)
    error_message = "deployment_mode must be manual or github."
  }
}
variable "observer_principal_arn" {
  type = string
  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:(user|role)/.+$", var.observer_principal_arn))
    error_message = "Observer trust must bind an existing named user/role, never root."
  }

}
variable "budget_email" {
  type = string
}
variable "monthly_budget_usd" {
  type    = number
  default = 50
  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 50
    error_message = "User-authorized ceiling is 50 USD/month."
  }

}
variable "max_session_hours" {
  type    = number
  default = 4
  validation {
    condition     = var.max_session_hours >= 1 && var.max_session_hours <= 12
    error_message = "Session limit must be 1..12 hours."
  }

}
