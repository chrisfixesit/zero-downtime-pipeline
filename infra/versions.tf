# infra/versions.tf
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }

  # Created by infra/bootstrap.
  backend "s3" {
    bucket       = "zdp-tfstate-385467776718"
    key          = "zero-downtime-pipeline/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags { tags = local.tags }
}
