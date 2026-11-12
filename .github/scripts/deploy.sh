#!/usr/bin/env bash
# Deploys one release (an app image digest) to one environment through
# CodeDeploy blue/green: register a task definition from the pinned base
# revision, start the deployment, wait for CodeDeploy to finish, then record
# the release as that environment's last-good. Nothing is resolved by tag.
# CodeDeploy runs the smoke hook and rolls traffic back on failure or alarm.
# Usage: deploy.sh <env> <release.json>   (env RUN_URL optional)
set -euo pipefail
ENV="$1"; RELEASE="$2"
# valid_release <file>: a sha and sha256 digests for every key in .digests,
# with at least `app` present (extra fields allowed).
valid_release() {
  jq -e '(.sha | test("^[0-9a-f]{40}$")) and (.digests | type == "object" and has("app") and all(.[]; type == "string" and test("^sha256:[0-9a-f]{64}$")))' "$1" >/dev/null 2>&1
}
valid_release "$RELEASE" || { echo "::error::$RELEASE is not a valid release" >&2; exit 1; }

P="/zdp/$ENV"
get() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
REGISTRY=$(get /zdp/shared/ecr-registry)
HOOK=$(get /zdp/shared/smoke-hook-arn)
CLUSTER=$(get "$P/cluster")
SERVICE=$(get "$P/app-service")
SHA=$(jq -er .sha "$RELEASE")
IMAGE="$REGISTRY/zdp/app@$(jq -er .digests.app "$RELEASE")"

# Register a new revision from the base revision <base-arn> (pinned in SSM by
# tofu, never "latest in family") with container <name> pointed at <image>
# and VERSION=<sha>, which the smoke hook reads to know what it is checking.
register() {
  aws ecs describe-task-definition --task-definition "$1" --query taskDefinition --output json \
  | jq --arg name "$2" --arg img "$3" --arg sha "$4" '
      del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
          .registeredAt, .registeredBy, .deregisteredAt)
      | .containerDefinitions |= map(
          if .name == $name
          then .image = $img
               | .environment = ((.environment // []) | map(select(.name != "VERSION")) + [{name: "VERSION", value: $sha}])
          else . end)' > td.json
  aws ecs register-task-definition --cli-input-json file://td.json --query taskDefinition.taskDefinitionArn --output text
}

TD=$(register "$(get "$P/app-base-taskdef")" app "$IMAGE" "$SHA")

# CodeDeploy needs a running task to shift traffic from, so a service parked
# at zero is brought to one first.
DESIRED=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].desiredCount' --output text)
if [ "$DESIRED" = "0" ]; then
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 >/dev/null
fi

# The appspec is a JSON string (the smoke hook JSON.parses it). jq would print
# 0.0 as 0, so the version goes in as a placeholder and is swapped for 0.0.
APPSPEC=$(jq -nc --arg td "$TD" --arg hook "$HOOK" '{
    version: "__VERSION__",
    Resources: [{TargetService: {Type: "AWS::ECS::Service", Properties: {
      TaskDefinition: $td,
      LoadBalancerInfo: {ContainerName: "app", ContainerPort: 8080}}}}],
    Hooks: [{AfterAllowTestTraffic: $hook}]}' | sed 's/"__VERSION__"/0.0/')
jq -n --arg content "$APPSPEC" '{revisionType: "AppSpecContent", appSpecContent: {content: $content}}' > revision.json

ID=$(aws deploy create-deployment --application-name "$(get "$P/codedeploy-app")" \
  --deployment-group-name "$(get "$P/deployment-group")" --revision file://revision.json \
  --query deploymentId --output text)
echo "Started CodeDeploy deployment $ID for ${SHA:0:7} in $ENV"

# The deployer role cannot stop deployments; CodeDeploy ends them itself
# (alarm, hook failure, termination wait), so this only waits and reports.
LAST=""
for _ in $(seq 1 160); do
  INFO=$(aws deploy get-deployment --deployment-id "$ID" --query deploymentInfo --output json)
  STATUS=$(jq -r .status <<< "$INFO")
  [ "$STATUS" = "$LAST" ] || { echo "Deployment $ID: $STATUS"; LAST=$STATUS; }
  case "$STATUS" in
    Succeeded)
      jq --arg at "$(date -u +%FT%TZ)" --arg run "${RUN_URL:-}" '. + {deployedAt: $at, runUrl: $run}' "$RELEASE" > pointer.json
      aws ssm put-parameter --name "$P/last-good" --type String --overwrite --value file://pointer.json >/dev/null
      echo "Recorded $SHA as $ENV last-good. Live at $(get "$P/app-url")"
      exit 0 ;;
    Failed|Stopped)
      echo "::error::$ENV deployment $ID $STATUS: $(jq -r '.errorInformation.code // "" ' <<< "$INFO") $(jq -r '.errorInformation.message // ""' <<< "$INFO"); CodeDeploy returned traffic to the previous release; nothing recorded" >&2
      exit 1 ;;
  esac
  sleep 15
done
echo "::error::$ENV deployment $ID did not finish in 40 minutes (last status $LAST); nothing recorded" >&2
exit 1
