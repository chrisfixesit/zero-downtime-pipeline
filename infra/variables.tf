variable "project" {
  description = "Project name used as a resource prefix"
  type        = string
  default     = "zdp"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "github_repo" {
  description = "GitHub org/repo allowed to assume the deploy role via OIDC"
  type        = string
  default     = "christophercorbin/zero-downtime-pipeline"
}
