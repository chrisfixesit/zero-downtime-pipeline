# infra/alb.tf
# One internet-facing ALB. Each environment gets a prod listener (port) and a
# test listener (test_port); both live in the env module with its target groups.
# The test ports are public because the smoke-hook Lambda runs outside the VPC
# and reaches green through them (README, Design choices).
resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = data.aws_subnets.default.ids
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "zdp ALB: prod and test listeners for every environment"
  vpc_id      = data.aws_vpc.default.id

  dynamic "ingress" {
    for_each = toset(flatten([for e in local.envs : [e.port, e.test_port]]))
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    description = "To tasks in the VPC"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.default.cidr_block]
  }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "zdp tasks: app port from the ALB only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Image pulls, logs and AppConfig go out over the public IP (no NAT).
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
