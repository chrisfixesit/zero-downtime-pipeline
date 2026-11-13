# infra/bootstrap/backend.tf
# Bootstrap's own state lives in the bucket it creates, beside the main
# stack's. The bucket must exist first: on a fresh copy, apply once with this
# file moved aside, then restore it and run `tofu init -migrate-state`
# (README, Setup, step 3).
terraform {
  backend "s3" {
    bucket       = "zdp-tfstate-385467776718"
    key          = "bootstrap/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
