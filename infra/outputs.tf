output "alb_url" {
  description = "Public URL of the demo service"
  value       = "http://${aws_lb.this.dns_name}"
}

output "ecr_repository" {
  description = "ECR repository URL for app images"
  value       = aws_ecr_repository.app.repository_url
}

output "github_deploy_role_arn" {
  description = "Role ARN for the GitHub Actions OIDC workflow (set as AWS_DEPLOY_ROLE_ARN repo variable)"
  value       = aws_iam_role.github_deploy.arn
}

output "codedeploy_app" {
  value = aws_codedeploy_app.this.name
}

output "codedeploy_deployment_group" {
  value = aws_codedeploy_deployment_group.this.deployment_group_name
}
