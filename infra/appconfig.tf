# infra/appconfig.tf
# Feature flags: native feature-flag profile, a schema validator, and an
# all-at-once deployment that AppConfig rolls back by itself when the
# environment's 5xx alarm fires during its 5-minute watch.
#
# One AppConfig application per environment, for defence in depth.
# CreateHostedConfigurationVersion requires both the application and the
# profile ARN to be allowed. Separate applications keep each environment's
# grants, reads and future teardown fully independent.
resource "aws_appconfig_application" "this" {
  for_each = local.envs
  name     = "${local.name}-${each.key}"
}

resource "aws_iam_role" "appconfig_monitor" {
  name = "${local.name}-appconfig-monitor"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "appconfig.amazonaws.com" } }]
  })
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy" "appconfig_monitor" {
  role = aws_iam_role.appconfig_monitor.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["cloudwatch:DescribeAlarms"], Resource = "*" }]
  })
}

resource "aws_appconfig_environment" "env" {
  for_each       = local.envs
  application_id = aws_appconfig_application.this[each.key].id
  name           = each.key

  monitor {
    alarm_arn      = module.env[each.key].alarm_arn
    alarm_role_arn = aws_iam_role.appconfig_monitor.arn
  }
}

# One profile per environment, inside that environment's own application.
resource "aws_appconfig_configuration_profile" "flags" {
  for_each       = local.envs
  application_id = aws_appconfig_application.this[each.key].id
  name           = "flags-${each.key}"
  type           = "AWS.AppConfig.FeatureFlags"
  location_uri   = "hosted"

  validator {
    type    = "JSON_SCHEMA"
    content = file("${path.module}/appconfig/flags.schema.json")
  }
}

# All at once, then a 5-minute watch. Each environment runs one app task, so
# a linear rollout would hand it the new value at a random step and could
# leave less watch than the 5xx alarm needs to fire (about 2m45s, plus the
# agent's 45 s poll). Deploying at once starts the whole bake at the change.
# Bring back a short linear phase if environments run several tasks.
# growth_factor stays 25: with no duration every step lands at once anyway, and
# AWS provider 5.100.0 panics updating growth_factor in place (float64/float32).
resource "aws_appconfig_deployment_strategy" "linear" {
  name                           = "${local.name}-linear"
  growth_type                    = "LINEAR"
  growth_factor                  = 25
  deployment_duration_in_minutes = 0
  final_bake_time_in_minutes     = 5
  replicate_to                   = "NONE"
}

# Every environment starts with an empty flag document (every flag at its
# registry default, off) deployed once. Without it, a flag's first flip is the
# environment's first deployment, and rolling that back leaves nothing to
# return to: the agent keeps serving the rolled-back value. No watch here, so
# the baseline itself cannot be rolled back.
resource "aws_appconfig_deployment_strategy" "baseline" {
  name                           = "${local.name}-baseline"
  growth_type                    = "LINEAR"
  growth_factor                  = 100
  deployment_duration_in_minutes = 0
  final_bake_time_in_minutes     = 0
  replicate_to                   = "NONE"
}

resource "aws_appconfig_hosted_configuration_version" "baseline" {
  for_each                 = local.envs
  application_id           = aws_appconfig_application.this[each.key].id
  configuration_profile_id = aws_appconfig_configuration_profile.flags[each.key].configuration_profile_id
  content_type             = "application/json"
  content                  = jsonencode({ version = "1", flags = {}, values = {} })
}

resource "aws_appconfig_deployment" "baseline" {
  for_each                 = local.envs
  application_id           = aws_appconfig_application.this[each.key].id
  environment_id           = aws_appconfig_environment.env[each.key].environment_id
  configuration_profile_id = aws_appconfig_configuration_profile.flags[each.key].configuration_profile_id
  configuration_version    = aws_appconfig_hosted_configuration_version.baseline[each.key].version_number
  deployment_strategy_id   = aws_appconfig_deployment_strategy.baseline.id
  description              = "Baseline: every flag at its registry default"
}

resource "aws_ssm_parameter" "appconfig_shared" {
  name  = "/${local.name}/shared/appconfig-strategy-id"
  type  = "String"
  value = aws_appconfig_deployment_strategy.linear.id
}

resource "aws_ssm_parameter" "appconfig_env" {
  for_each = local.envs
  name     = "/${local.name}/${each.key}/appconfig-environment-id"
  type     = "String"
  value    = aws_appconfig_environment.env[each.key].environment_id
}

resource "aws_ssm_parameter" "appconfig_env_application" {
  for_each = local.envs
  name     = "/${local.name}/${each.key}/appconfig-application-id"
  type     = "String"
  value    = aws_appconfig_application.this[each.key].id
}

resource "aws_ssm_parameter" "appconfig_env_profile" {
  for_each = local.envs
  name     = "/${local.name}/${each.key}/appconfig-profile-id"
  type     = "String"
  value    = aws_appconfig_configuration_profile.flags[each.key].configuration_profile_id
}

# ---- Task role: reads only this environment's own application ----
resource "aws_iam_role_policy" "task_appconfig" {
  for_each = local.envs
  name     = "appconfig"
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["appconfig:StartConfigurationSession", "appconfig:GetLatestConfiguration"]
      Resource = [
        "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}",
        "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}/*",
      ]
    }]
  })
}

# ---- Flag flips: each deployer, its own AppConfig environment only ----
resource "aws_iam_role_policy" "deployer_flags" {
  for_each = local.envs
  name     = "flags"
  role     = aws_iam_role.deployer[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # These actions require both the application and the profile ARN
        # (AWS Service Authorization Reference). A hosted configuration
        # version's ARN is the profile ARN itself, so no version suffix.
        # Both are this environment's own, never another's.
        Effect = "Allow"
        Action = ["appconfig:CreateHostedConfigurationVersion", "appconfig:GetHostedConfigurationVersion"]
        Resource = [
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}",
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}/configurationprofile/${aws_appconfig_configuration_profile.flags[each.key].configuration_profile_id}",
        ]
      },
      {
        Effect = "Allow"
        Action = ["appconfig:StartDeployment", "appconfig:GetDeployment", "appconfig:ListDeployments"]
        Resource = [
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}",
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}/environment/${aws_appconfig_environment.env[each.key].environment_id}",
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}/environment/${aws_appconfig_environment.env[each.key].environment_id}/deployment/*",
          "arn:aws:appconfig:us-east-1:${local.account}:application/${aws_appconfig_application.this[each.key].id}/configurationprofile/${aws_appconfig_configuration_profile.flags[each.key].configuration_profile_id}",
          "arn:aws:appconfig:us-east-1:${local.account}:deploymentstrategy/${aws_appconfig_deployment_strategy.linear.id}",
        ]
      },
    ]
  })
}
