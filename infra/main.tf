# infra/main.tf
# One shared footprint (cluster, ALB, ECR, CodeDeploy app) holding three
# logical environments, each on its own prod and test listener port.
locals {
  name = "zdp"

  envs = {
    sandbox = { port = 8081, test_port = 9081, config = "CodeDeployDefault.ECSAllAtOnce", termination_wait = 1 }
    staging = { port = 8082, test_port = 9082, config = "CodeDeployDefault.ECSCanary10Percent5Minutes", termination_wait = 5 }
    prod    = { port = 8083, test_port = 9083, config = "CodeDeployDefault.ECSCanary10Percent5Minutes", termination_wait = 5 }
  }

  tags = {
    Project   = "zero-downtime-pipeline"
    ManagedBy = "opentofu"
  }

  account = data.aws_caller_identity.current.account_id

  # Both OIDC subject forms: classic, and the immutable owner@id/repo@id form.
  repo_owner = split("/", var.github_repo)[0]
  repo_name  = split("/", var.github_repo)[1]
  oidc_repos = [
    "repo:${var.github_repo}",
    "repo:${local.repo_owner}@*/${local.repo_name}@*",
  ]
}

variable "github_repo" {
  type        = string
  description = "owner/repo whose GitHub Actions may assume the roles below."
  default     = "chrisfixesit/zero-downtime-pipeline"

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "github_repo must be owner/repo."
  }
}

variable "permissions_boundary_arn" {
  type        = string
  description = "Optional IAM permissions boundary applied to every role this stack creates."
  default     = null
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Already exists in the account (shared with other projects); never created here.
data "aws_iam_openid_connect_provider" "github" {
  arn = "arn:aws:iam::385467776718:oidc-provider/token.actions.githubusercontent.com"
}
