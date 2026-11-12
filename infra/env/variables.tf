# infra/env/variables.tf
variable "env" { type = string }
variable "name" { type = string }
variable "port" {
  type        = number
  description = "Prod listener port: user traffic."
}
variable "test_port" {
  type        = number
  description = "Test listener port: green only, used by the smoke hook before traffic shifts."
}
variable "deployment_config" { type = string }
variable "termination_wait" {
  type        = number
  description = "Minutes blue keeps running after a successful shift."
}
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "tasks_sg_id" { type = string }
variable "alb_arn" { type = string }
variable "alb_arn_suffix" { type = string }
variable "alb_dns_name" { type = string }
variable "cluster_arn" { type = string }
variable "cluster_name" { type = string }
variable "exec_role_arn" { type = string }
variable "task_role_arn" { type = string }
variable "codedeploy_app_name" { type = string }
variable "codedeploy_role_arn" { type = string }
