# infra/outputs.tf
output "deployer_role_arns" { value = { for k, r in aws_iam_role.deployer : k => r.arn } }
output "pr_read_role_arn" { value = aws_iam_role.promotion_read.arn }
output "main_read_role_arn" { value = aws_iam_role.drift_read.arn }
output "app_urls" { value = { for k, m in module.env : k => m.app_url } }
output "alb_dns_name" { value = aws_lb.this.dns_name }
