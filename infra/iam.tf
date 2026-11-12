# infra/iam.tf
# Every role: optional permissions boundary, inline policies only. Deployers
# are per environment and trusted only for that GitHub Environment's OIDC
# subject; the two read roles serve checks that run outside any Environment.
locals {
  env_arns = { for env, _ in local.envs : env => {
    params           = "arn:aws:ssm:us-east-1:${local.account}:parameter/${local.name}/${env}/*"
    logs             = "arn:aws:logs:us-east-1:${local.account}:log-group:/ecs/${local.name}-${env}:*"
    deployment_group = "arn:aws:codedeploy:us-east-1:${local.account}:deploymentgroup:${local.name}/${local.name}-${env}"
  } }
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# GitHub OIDC trust for one subject suffix, in both subject forms.
data "aws_iam_policy_document" "github_trust" {
  for_each = merge(
    { for env, _ in local.envs : "deployer-${env}" => "environment:${env}" },
    { "promotion-read" = "pull_request", "drift-read" = "ref:refs/heads/main" },
  )

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for repo in local.oidc_repos : "${repo}:${each.value}"]
    }
  }
}

# ---- Task execution and task roles, one pair per environment ----

resource "aws_iam_role" "exec" {
  for_each             = local.envs
  name                 = "${local.name}-${each.key}-exec"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "exec" {
  for_each = local.envs
  role     = aws_iam_role.exec[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = [aws_ecr_repository.app.arn] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = local.env_arns[each.key].logs },
    ]
  })
}

# Statements are added in appconfig.tf (task_appconfig), which references the
# environment's AppConfig application.
resource "aws_iam_role" "task" {
  for_each             = local.envs
  name                 = "${local.name}-${each.key}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_trust.json
  permissions_boundary = var.permissions_boundary_arn
}

# ---- Deployers: one per environment, trusted only for that GitHub Environment ----

resource "aws_iam_role" "deployer" {
  for_each             = local.envs
  name                 = "${local.name}-deployer-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.github_trust["deployer-${each.key}"].json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "deployer" {
  for_each = local.envs
  role     = aws_iam_role.deployer[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:DescribeImages", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer"], Resource = [aws_ecr_repository.app.arn] },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:DescribeServices", "ecs:DescribeTasks"], Resource = "*" },
      # Scale a service still at zero to one before its first deploy.
      { Effect = "Allow", Action = ["ecs:UpdateService"], Resource = "arn:aws:ecs:us-east-1:${local.account}:service/${local.name}/${local.name}-${each.key}-app" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.exec[each.key].arn, aws_iam_role.task[each.key].arn], Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } },
      # Deployments only into this environment's own deployment group. Stop is
      # for deploy.sh's 40-minute timeout, which stops with auto-rollback.
      { Effect = "Allow", Action = ["codedeploy:CreateDeployment", "codedeploy:GetDeployment", "codedeploy:GetDeploymentGroup", "codedeploy:StopDeployment"], Resource = local.env_arns[each.key].deployment_group },
      { Effect = "Allow", Action = ["codedeploy:GetDeploymentConfig"], Resource = "arn:aws:codedeploy:us-east-1:${local.account}:deploymentconfig:*" },
      { Effect = "Allow", Action = ["codedeploy:RegisterApplicationRevision", "codedeploy:GetApplicationRevision"], Resource = "arn:aws:codedeploy:us-east-1:${local.account}:application:${aws_codedeploy_app.this.name}" },
      { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters"], Resource = [local.env_arns[each.key].params, "arn:aws:ssm:us-east-1:${local.account}:parameter/${local.name}/shared/*"] },
      { Effect = "Allow", Action = ["ssm:PutParameter"], Resource = "arn:aws:ssm:us-east-1:${local.account}:parameter/${local.name}/${each.key}/last-good" },
      { Effect = "Allow", Action = ["logs:GetLogEvents"], Resource = local.env_arns[each.key].logs },
      ],
      # Only the sandbox deployer pushes images; later stages run what sandbox built.
      each.key == "sandbox" ? [
        { Effect = "Allow", Action = ["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"], Resource = [aws_ecr_repository.app.arn] },
        # The image build cache (main's build job runs as this role).
        { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"], Resource = [aws_ecr_repository.buildcache.arn] },
      ] : [],
    )
    # Flag flips are a separate policy (deployer_flags in appconfig.tf), scoped
    # to this environment's AppConfig environment, so the sandbox deployer
    # cannot flip prod flags.
  })
}

# ---- Read-only roles for checks that run outside any GitHub Environment ----

resource "aws_iam_role" "promotion_read" {
  name                 = "${local.name}-promotion-read"
  assume_role_policy   = data.aws_iam_policy_document.github_trust["promotion-read"].json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "promotion_read" {
  role = aws_iam_role.promotion_read.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ssm:GetParameterHistory"], Resource = "arn:aws:ssm:us-east-1:${local.account}:parameter/${local.name}/*/last-good" }]
  })
}

# Scheduled and dispatched runs on main carry sub ref:refs/heads/main and no
# environment. Used by drift-check, promote, rollback and apply's verify jobs.
resource "aws_iam_role" "drift_read" {
  name                 = "${local.name}-drift-read"
  assume_role_policy   = data.aws_iam_policy_document.github_trust["drift-read"].json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "drift_read" {
  role = aws_iam_role.drift_read.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ssm:GetParameterHistory", "ssm:GetParameter"], Resource = "arn:aws:ssm:us-east-1:${local.account}:parameter/${local.name}/*" },
      { Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition"], Resource = "*" },
    ]
  })
}
