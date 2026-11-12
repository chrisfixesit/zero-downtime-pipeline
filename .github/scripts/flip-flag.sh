#!/usr/bin/env bash
# Turns one flag on or off in one environment through an AppConfig
# deployment (all at once, then a 5-minute alarm-guarded watch), then waits
# for the outcome.
# Usage: flip-flag.sh <env> <flag> <on|off>
set -euo pipefail
ENV="$1"; FLAG="$2"; STATE="$3"
get() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
APP=$(get "/zdp/$ENV/appconfig-application-id")
PROFILE=$(get "/zdp/$ENV/appconfig-profile-id")
STRATEGY=$(get /zdp/shared/appconfig-strategy-id)
ENVID=$(get "/zdp/$ENV/appconfig-environment-id")

# The backticks are a JMESPath literal, not shell expansion.
# shellcheck disable=SC2016
LATEST=$(aws appconfig list-deployments --application-id "$APP" --environment-id "$ENVID" \
  --query 'sort_by(Items[?State==`COMPLETE`], &DeploymentNumber)[-1].ConfigurationVersion' --output text)
if [ "$LATEST" != "None" ] && [ -n "$LATEST" ]; then
  aws appconfig get-hosted-configuration-version --application-id "$APP" --configuration-profile-id "$PROFILE" \
    --version-number "$LATEST" current.json >/dev/null
else
  echo '{}' > current.json
fi

# The flags the environment's running release declares, from its own registry
# (import-free by design, so plain Node loads it). A flag added on main is not
# read until its code is promoted, so flag-config refuses it here. Running that
# commit's registry with deployer credentials is acceptable: the same code
# already runs in this environment, and only deployers write last-good.
RELEASE_SHA=$(get "/zdp/$ENV/last-good" | jq -er '.sha | select(test("^[0-9a-f]{40}$"))') \
  || { echo "::error::No running release recorded for $ENV in last-good"; exit 1; }
git fetch --quiet --depth=1 origin "$RELEASE_SHA"
git show "${RELEASE_SHA}:src/core/flags/registry.ts" > release-registry.ts
node --input-type=module -e "const { flagRegistry } = await import('./release-registry.ts'); console.log(JSON.stringify(flagRegistry))" > release-flags.json
echo "$ENV runs ${RELEASE_SHA:0:7}; it declares: $(jq -r 'keys | join(", ")' release-flags.json)"

node scripts/delivery/cli.ts flag-config "$FLAG" "$STATE" current.json release-flags.json > next.json
VERSION=$(aws appconfig create-hosted-configuration-version --application-id "$APP" --configuration-profile-id "$PROFILE" \
  --content-type application/json --content fileb://next.json version.out --query VersionNumber --output text)
DEPLOYMENT=$(aws appconfig start-deployment --application-id "$APP" --environment-id "$ENVID" \
  --deployment-strategy-id "$STRATEGY" --configuration-profile-id "$PROFILE" --configuration-version "$VERSION" \
  --description "$FLAG=$STATE via flag.yml" --query DeploymentNumber --output text)
echo "Deployment $DEPLOYMENT: $FLAG=$STATE in $ENV (version $VERSION)"

for _ in $(seq 1 60); do
  S=$(aws appconfig get-deployment --application-id "$APP" --environment-id "$ENVID" --deployment-number "$DEPLOYMENT" --query State --output text)
  case "$S" in
    COMPLETE) echo "### $FLAG is $STATE in $ENV" >> "$GITHUB_STEP_SUMMARY"; exit 0 ;;
    ROLLED_BACK) echo "::error::AppConfig rolled $FLAG back in $ENV (alarm fired or deployment stopped)"; exit 1 ;;
  esac
  sleep 15
done
echo "::error::Deployment $DEPLOYMENT did not finish in 15 minutes"; exit 1
