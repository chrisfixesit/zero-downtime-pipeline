# infra/env/outputs.tf
output "alarm_arn" { value = aws_cloudwatch_metric_alarm.target_5xx.arn }
output "app_url" { value = local.app_url }
