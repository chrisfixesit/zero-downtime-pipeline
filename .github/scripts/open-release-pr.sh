#!/usr/bin/env bash
# Opens a promotion or rollback PR from a cli.ts payload, as the automation
# App (GH_TOKEN must be an App token; GITHUB_TOKEN-created PRs never get CI).
# Closes older open PRs for the same environment. Usage: open-release-pr.sh <payload.json>
set -euo pipefail
F="$1"
ENV=$(jq -er .env "$F"); FILE=$(jq -er .file "$F"); BRANCH=$(jq -er .branch "$F"); TITLE=$(jq -er .title "$F")
mkdir -p deploy
jq -j .fileContent "$F" > "$FILE"
if git diff --quiet -- "$FILE" && git ls-files --error-unmatch "$FILE" >/dev/null 2>&1; then
  echo "::notice::$FILE already asks for this release; no PR needed."
  exit 0
fi

# The bot identity is whichever App minted GH_TOKEN (APP_SLUG from the token step).
BOT="${APP_SLUG:?APP_SLUG must be the App slug}[bot]"
BOT_ID=$(gh api "/users/$(printf %s "$BOT" | jq -sRr @uri)" --jq .id)
git config user.name "$BOT"
git config user.email "$BOT_ID+$BOT@users.noreply.github.com"
git switch -c "$BRANCH"
git add "$FILE"
git commit -qm "$TITLE"
# The checkout does not persist credentials, so push with the App token
# explicitly; it never lands in .git/config.
git push -q "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$BRANCH"

LABEL="promotion:$ENV"
gh label create "$LABEL" --color FBCA04 --description "Release request for $ENV" 2>/dev/null || true
NEW=$(gh pr create --base main --head "$BRANCH" --title "$TITLE" --body "$(jq -er .body "$F")" --label "$LABEL")
echo "Opened $NEW"
for n in $(gh pr list --label "$LABEL" --state open --json number,url --jq ".[] | select(.url != \"$NEW\") | .number"); do
  gh pr close "$n" --delete-branch --comment "Superseded by $NEW"
done
echo "### Opened $NEW" >> "$GITHUB_STEP_SUMMARY"
