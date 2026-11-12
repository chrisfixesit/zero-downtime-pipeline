# infra/smoke-hook.tf
# The AfterAllowTestTraffic hook every deployment's appspec names. It runs
# outside the VPC and smoke-tests green through the environment's public test
# listener; a Failed status stops the deployment before any user traffic.
data "archive_file" "smoke_hook" {
  type        = "zip"
  source_dir  = "${path.module}/smoke-hook"
  output_path = "${path.module}/.build/smoke-hook.zip"
}

resource "aws_iam_role" "smoke_hook" {
  name = "${local.name}-smoke-hook"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "smoke_hook_logs" {
  role       = aws_iam_role.smoke_hook.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "smoke_hook" {
  role = aws_iam_role.smoke_hook.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["codedeploy:PutLifecycleEventHookExecutionStatus", "codedeploy:GetDeployment"], Resource = "arn:aws:codedeploy:us-east-1:${local.account}:deploymentgroup:${local.name}/*" },
      { Effect = "Allow", Action = ["codedeploy:GetApplicationRevision"], Resource = "arn:aws:codedeploy:us-east-1:${local.account}:application:${local.name}" },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*" },
    ]
  })
}

resource "aws_cloudwatch_log_group" "smoke_hook" {
  name              = "/aws/lambda/CodeDeployHook_${local.name}-smoke"
  retention_in_days = 14
}

resource "aws_lambda_function" "smoke_hook" {
  function_name    = "CodeDeployHook_${local.name}-smoke"
  role             = aws_iam_role.smoke_hook.arn
  runtime          = "nodejs22.x" # the newest Node runtime AWS provider 5.x accepts
  handler          = "index.handler"
  filename         = data.archive_file.smoke_hook.output_path
  source_code_hash = data.archive_file.smoke_hook.output_base64sha256
  timeout          = 180

  environment {
    variables = {
      TEST_URLS = jsonencode({ for env, e in local.envs : "${local.name}-${env}" => "http://${aws_lb.this.dns_name}:${e.test_port}" })
    }
  }

  depends_on = [aws_cloudwatch_log_group.smoke_hook, aws_iam_role_policy_attachment.smoke_hook_logs]
}

resource "aws_ssm_parameter" "shared" {
  for_each = {
    smoke-hook-arn = aws_lambda_function.smoke_hook.arn
    ecr-registry   = split("/", aws_ecr_repository.app.repository_url)[0]
  }
  name  = "/${local.name}/shared/${each.key}"
  type  = "String"
  value = each.value
}
