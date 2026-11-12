#!/usr/bin/env bash
# scripts/configure-github.sh
# One-time GitHub setup, run after `tofu apply` in infra/. Needs repo admin
# and a gh login on the repo's owner account.
# Usage: scripts/configure-github.sh <automation-app-id>
# The App's private key (AUTOMATION_APP_KEY, a secret in the release-automation
# environment) is the one step left to do by hand; this script prints it.
set -euo pipefail
APP_ID="${1:?usage: scripts/configure-github.sh <automation-app-id>}"
R="${GITHUB_REPO:-chrisfixesit/zero-downtime-pipeline}"
OUT=$(cd "$(dirname "$0")/../infra" && AWS_PROFILE="${AWS_PROFILE:-personal-sandbox}" tofu output -json)

# Every environment deploys from main only.
for env in sandbox staging prod release-automation; do
  gh api -X PUT "repos/$R/environments/$env" --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' >/dev/null
  # Fails harmlessly when the policy already exists (re-runs).
  gh api -X POST "repos/$R/environments/$env/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
done

for env in sandbox staging prod; do
  gh variable set DEPLOYER_ROLE_ARN -R "$R" --env "$env" --body "$(jq -er ".deployer_role_arns.value.$env" <<<"$OUT")"
done

gh variable set PR_READ_ROLE_ARN -R "$R" --body "$(jq -er .pr_read_role_arn.value <<<"$OUT")"
gh variable set MAIN_READ_ROLE_ARN -R "$R" --body "$(jq -er .main_read_role_arn.value <<<"$OUT")"
gh variable set AUTOMATION_APP_ID -R "$R" --body "$APP_ID"

# Actions may not approve PRs, so no workflow can satisfy its own review.
gh api -X PUT "repos/$R/actions/permissions/workflow" -F can_approve_pull_request_reviews=false -f default_workflow_permissions=read

# Branch protection needs main to exist on GitHub. Before the first push,
# stop here; re-running after it is safe and applies the protection.
if ! gh api "repos/$R/branches/main" >/dev/null 2>&1; then
  echo "Configured environments and variables for $R."
  echo "main is not on GitHub yet: set AUTOMATION_APP_KEY (below), push main, then re-run this script to protect it."
  echo "  gh secret set AUTOMATION_APP_KEY -R $R --env release-automation < <path-to-app-private-key.pem>"
  exit 0
fi

# enforce_admins is off on purpose: with one maintainer, their own PRs to
# gated paths merge through the admin bypass, which GitHub logs (README).
gh api -X PUT "repos/$R/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["ci-ok", "promotion-check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "require_code_owner_reviews": true,
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "Configured $R."
echo "One step left: set the App's private key as AUTOMATION_APP_KEY in release-automation:"
echo "  gh secret set AUTOMATION_APP_KEY -R $R --env release-automation < <path-to-app-private-key.pem>"
