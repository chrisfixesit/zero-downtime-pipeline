# infra/ecr.tf
# One immutable tag per commit (the SHA): describe-images imageTag=<sha> gives
# the digest forever, and a digest that ran in sandbox cannot be replaced.
# No expiry rule: an age or count rule would eventually delete digests that
# staging or prod still run, and every task replacement or rollback would
# then fail to pull.
resource "aws_ecr_repository" "app" {
  name                 = "${local.name}/app"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }
}

# BuildKit's registry layer cache. Separate from the release repo so a cache
# manifest can never be resolved as a release.
resource "aws_ecr_repository" "buildcache" {
  name = "${local.name}/buildcache"
  # Mutable because BuildKit's registry cache rewrites a fixed tag on every build.
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration { scan_on_push = true }
}

# Each rewrite leaves the previous cache manifest untagged.
resource "aws_ecr_lifecycle_policy" "buildcache" {
  repository = aws_ecr_repository.buildcache.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire superseded cache manifests"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
      action       = { type = "expire" }
    }]
  })
}
