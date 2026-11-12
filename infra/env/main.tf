# infra/env/main.tf
# Everything one logical environment owns inside the shared footprint: blue
# and green target groups, prod and test listeners, the service CodeDeploy
# rolls, its deployment group and the 5xx alarm that guards deploys and flag
# flips alike.
locals {
  prefix  = "${var.name}-${var.env}"
  app_url = "http://${var.alb_dns_name}:${var.port}"
  # Placeholder until the first deploy registers a real revision; the service
  # ignores task_definition changes (CI owns the running revision).
  placeholder = "public.ecr.aws/docker/library/node:26-alpine"

  log_config = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this.name
      awslogs-region        = "us-east-1"
      awslogs-stream-prefix = "ecs"
    }
  }

  appconfig_agent = {
    name             = "appconfig-agent"
    image            = "public.ecr.aws/aws-appconfig/aws-appconfig-agent:2.x"
    essential        = false
    portMappings     = [{ containerPort = 2772, protocol = "tcp" }]
    environment      = [{ name = "SERVICE_REGION", value = "us-east-1" }]
    logConfiguration = local.log_config
  }
}

resource "aws_lb_target_group" "this" {
  for_each = toset(["blue", "green"])

  name        = "${local.prefix}-${each.key}"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/healthz"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# CodeDeploy swaps which target group each listener forwards to.
resource "aws_lb_listener" "this" {
  for_each = { prod = var.port, test = var.test_port }

  load_balancer_arn = var.alb_arn
  port              = each.value
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["blue"].arn
  }

  lifecycle { ignore_changes = [default_action] }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.prefix}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.exec_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name         = "app"
      image        = local.placeholder
      essential    = true
      portMappings = [{ containerPort = 8080, protocol = "tcp" }]
      environment = [
        { name = "PORT", value = "8080" },
        { name = "VERSION", value = "placeholder" },
        { name = "FLAGS_PROVIDER", value = "appconfig" },
        { name = "APPCONFIG_APPLICATION", value = local.prefix },
        { name = "APPCONFIG_ENVIRONMENT", value = var.env },
        { name = "APPCONFIG_PROFILE", value = "flags-${var.env}" },
      ]
      logConfiguration = local.log_config
    },
    local.appconfig_agent,
  ])
}

resource "aws_ecs_service" "app" {
  name            = "${local.prefix}-app"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  deployment_controller { type = "CODE_DEPLOY" }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.tasks_sg_id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this["blue"].arn
    container_name   = "app"
    container_port   = 8080
  }

  # CI owns the running revision and the count (the first deploy sets it to
  # 1); CodeDeploy owns which target group the service is on.
  lifecycle { ignore_changes = [task_definition, load_balancer, desired_count] }

  # ECS refuses a target group that no listener uses yet.
  depends_on = [aws_lb_listener.this]
}

# Summed over blue and green, so it sees errors from whichever one is serving.
# CodeDeploy stops and rolls back a deployment when it fires, and AppConfig
# rolls back a flag flip.
resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${local.prefix}-target-5xx"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 5
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "e1"
    expression  = "FILL(m1,0)+FILL(m2,0)"
    label       = "Target 5xx (blue + green)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { m1 = "blue", m2 = "green" }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/ApplicationELB"
        metric_name = "HTTPCode_Target_5XX_Count"
        stat        = "Sum"
        period      = 60
        dimensions = {
          LoadBalancer = var.alb_arn_suffix
          TargetGroup  = aws_lb_target_group.this[metric_query.value].arn_suffix
        }
      }
    }
  }
}

resource "aws_codedeploy_deployment_group" "this" {
  app_name               = var.codedeploy_app_name
  deployment_group_name  = local.prefix
  service_role_arn       = var.codedeploy_role_arn
  deployment_config_name = var.deployment_config

  deployment_style {
    deployment_type   = "BLUE_GREEN"
    deployment_option = "WITH_TRAFFIC_CONTROL"
  }

  ecs_service {
    cluster_name = var.cluster_name
    service_name = aws_ecs_service.app.name
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route { listener_arns = [aws_lb_listener.this["prod"].arn] }
      test_traffic_route { listener_arns = [aws_lb_listener.this["test"].arn] }
      target_group { name = aws_lb_target_group.this["blue"].name }
      target_group { name = aws_lb_target_group.this["green"].name }
    }
  }

  blue_green_deployment_config {
    deployment_ready_option { action_on_timeout = "CONTINUE_DEPLOYMENT" }
    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = var.termination_wait
    }
  }

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE", "DEPLOYMENT_STOP_ON_ALARM"]
  }

  alarm_configuration {
    enabled = true
    alarms  = [aws_cloudwatch_metric_alarm.target_5xx.alarm_name]
  }
}

resource "aws_ssm_parameter" "deploy" {
  for_each = {
    cluster     = var.cluster_name
    app-service = aws_ecs_service.app.name
    # The revision every deploy copies, pinned to what tofu registered. Deploys
    # must never copy "latest in family": every deployer can register
    # revisions, so the unreviewed sandbox identity could otherwise rewrite
    # prod's command or env and ride the next approved prod deploy.
    app-base-taskdef = aws_ecs_task_definition.app.arn
    codedeploy-app   = var.codedeploy_app_name
    deployment-group = aws_codedeploy_deployment_group.this.deployment_group_name
    app-url          = local.app_url
  }

  name  = "/${var.name}/${var.env}/${each.key}"
  type  = "String"
  value = each.value
}
