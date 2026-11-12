# infra/envs.tf
module "env" {
  source   = "./env"
  for_each = local.envs

  env                 = each.key
  name                = local.name
  port                = each.value.port
  test_port           = each.value.test_port
  deployment_config   = each.value.config
  termination_wait    = each.value.termination_wait
  vpc_id              = data.aws_vpc.default.id
  subnet_ids          = data.aws_subnets.default.ids
  tasks_sg_id         = aws_security_group.tasks.id
  alb_arn             = aws_lb.this.arn
  alb_arn_suffix      = aws_lb.this.arn_suffix
  alb_dns_name        = aws_lb.this.dns_name
  cluster_arn         = aws_ecs_cluster.this.arn
  cluster_name        = aws_ecs_cluster.this.name
  exec_role_arn       = aws_iam_role.exec[each.key].arn
  task_role_arn       = aws_iam_role.task[each.key].arn
  codedeploy_app_name = aws_codedeploy_app.this.name
  codedeploy_role_arn = aws_iam_role.codedeploy.arn
}
