# infra/codedeploy.tf
# One CodeDeploy application; each environment's deployment group is in the
# env module. AWSCodeDeployRoleForECS only lets CodeDeploy invoke Lambdas
# named CodeDeployHook_*, which is why the smoke hook carries that name.
resource "aws_codedeploy_app" "this" {
  name             = local.name
  compute_platform = "ECS"
}

resource "aws_iam_role" "codedeploy" {
  name = "${local.name}-codedeploy"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "codedeploy.amazonaws.com" } }]
  })
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  role       = aws_iam_role.codedeploy.name
  policy_arn = "arn:aws:iam::aws:policy/AWSCodeDeployRoleForECS"
}
