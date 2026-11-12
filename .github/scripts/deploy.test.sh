#!/usr/bin/env bash
# Tests deploy.sh against a stubbed aws (no network, no AWS).
# Run: bash .github/scripts/deploy.test.sh   (bash 3.2+ and jq)
# The fake aws answers from a case table; every call is logged to $STUB_LOG.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

mkdir -p "$root/bin"
cat > "$root/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
# arg <flag> <args...>: the argument after that flag.
arg() { local want=$1; shift; local p=""; for a in "$@"; do [ "$p" = "$want" ] && { echo "$a"; return; }; p=$a; done; }
case "$1 $2" in
  "ssm get-parameter")
    case "$(arg --name "$@")" in
      /zdp/shared/ecr-registry) echo reg.example ;;
      /zdp/shared/smoke-hook-arn) echo arn:aws:lambda:us-east-1:385467776718:function:CodeDeployHook_zdp-smoke ;;
      */cluster) echo zdp-cluster ;;
      */app-service) echo zdp-app ;;
      */app-base-taskdef) echo arn:aws:ecs:us-east-1:385467776718:task-definition/zdp-app:1 ;;
      */codedeploy-app) echo zdp-app ;;
      */deployment-group) echo zdp-app-dg ;;
      */app-url) echo https://sandbox.example ;;
      *) echo "unexpected parameter $*" >&2; exit 1 ;;
    esac ;;
  "ssm put-parameter")
    cp "$(arg --value "$@" | sed 's#^file://##')" "$STUB_DIR/put-value.json" ;;
  "ecs describe-task-definition")
    echo '{"taskDefinitionArn":"x","revision":1,"family":"zdp-app","containerDefinitions":[{"name":"app","image":"old","environment":[{"name":"VERSION","value":"old"},{"name":"PORT","value":"8080"}]},{"name":"sidecar","image":"keep"}]}' ;;
  "ecs register-task-definition")
    cp "$(arg --cli-input-json "$@" | sed 's#^file://##')" "$STUB_DIR/registered.json"
    echo arn:aws:ecs:us-east-1:385467776718:task-definition/zdp-app:2 ;;
  "ecs describe-services") echo "${STUB_DESIRED:-1}" ;;
  "ecs update-service") ;;
  "deploy create-deployment")
    cp "$(arg --revision "$@" | sed 's#^file://##')" "$STUB_DIR/revision.json"
    echo d-ABC123 ;;
  "deploy get-deployment") cat "$STUB_DIR/deployment.json" ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$root/bin/sleep"
chmod +x "$root/bin/aws" "$root/bin/sleep"

SHA=0123456789abcdef0123456789abcdef01234567
DIGEST=sha256:$(printf 'a%.0s' $(seq 1 64))

# run_case <name> <release-json>: fresh cwd and state; sets CODE, $STUB_LOG, $STUB_DIR, $cwd.
run_case() {
  cwd="$root/$1"; mkdir -p "$cwd"
  export STUB_DIR="$cwd" STUB_LOG="$cwd/log"; : > "$STUB_LOG"
  printf '%s' "$2" > "$cwd/release.json"
  CODE=0
  (cd "$cwd" && PATH="$root/bin:$PATH" RUN_URL=https://run.example/1 bash "$here/deploy.sh" sandbox release.json > out 2> err) || CODE=$?
}
good="{\"sha\":\"$SHA\",\"digests\":{\"app\":\"$DIGEST\"}}"
succeeded='{"status":"Succeeded"}'
stopped='{"status":"Stopped","errorInformation":{"code":"ALARM_ACTIVE","message":"alarm fired"}}'

# rejects an invalid release before any aws call
run_case invalid '{"sha":"nope","digests":{"app":"x"}}'
[ "$CODE" != 0 ] || fail "invalid release: expected non-zero exit"
[ ! -s "$STUB_LOG" ] || fail "invalid release: aws was called: $(cat "$STUB_LOG")"
echo "ok: rejects an invalid release before any aws call"

# a succeeded deployment records last-good
cwd="$root/succeeded"; mkdir -p "$cwd"; echo "$succeeded" > "$cwd/deployment.json"
run_case succeeded "$good"
[ "$CODE" = 0 ] || { cat "$cwd/err"; fail "succeeded: exit $CODE"; }
grep -q 'ssm put-parameter --name /zdp/sandbox/last-good' "$STUB_LOG" || fail "succeeded: last-good not written"
jq -e --arg sha "$SHA" '.sha == $sha and .digests.app != null and (.deployedAt | length > 0) and .runUrl == "https://run.example/1"' "$cwd/put-value.json" >/dev/null \
  || fail "succeeded: bad pointer: $(cat "$cwd/put-value.json")"
grep -q "Recorded $SHA as sandbox last-good. Live at https://sandbox.example" "$cwd/out" || fail "succeeded: summary line missing"
grep -q 'StopDeployment' "$STUB_LOG" && fail "StopDeployment must not be called"
grep -q 'describe-task-definition --task-definition arn:aws:ecs:us-east-1:385467776718:task-definition/zdp-app:1' "$STUB_LOG" \
  || fail "succeeded: did not register from the base revision ARN"
jq -e '.revisionType == "AppSpecContent"' "$cwd/revision.json" >/dev/null || fail "succeeded: revisionType"
content=$(jq -er '.appSpecContent.content' "$cwd/revision.json")
case "$content" in *0.0*) ;; *) fail "appspec content lacks version 0.0: $content" ;; esac
printf '%s' "$content" | jq -e '
  .Resources[0].TargetService.Type == "AWS::ECS::Service"
  and .Resources[0].TargetService.Properties.TaskDefinition == "arn:aws:ecs:us-east-1:385467776718:task-definition/zdp-app:2"
  and .Resources[0].TargetService.Properties.LoadBalancerInfo == {ContainerName: "app", ContainerPort: 8080}
  and .Hooks == [{AfterAllowTestTraffic: "arn:aws:lambda:us-east-1:385467776718:function:CodeDeployHook_zdp-smoke"}]' >/dev/null \
  || fail "appspec content wrong: $content"
echo "ok: a succeeded deployment records last-good"

# a stopped deployment records nothing
cwd="$root/stopped"; mkdir -p "$cwd"; echo "$stopped" > "$cwd/deployment.json"
run_case stopped "$good"
[ "$CODE" != 0 ] || fail "stopped: expected non-zero exit"
grep -q 'put-parameter' "$STUB_LOG" && fail "stopped: something was recorded"
grep -q 'ALARM_ACTIVE' "$cwd/err" || fail "stopped: stderr lacks ALARM_ACTIVE: $(cat "$cwd/err")"
echo "ok: a stopped deployment records nothing"

# scales a service at zero to one before deploying
cwd="$root/zero"; mkdir -p "$cwd"; echo "$succeeded" > "$cwd/deployment.json"
STUB_DESIRED=0 run_case zero "$good"
[ "$CODE" = 0 ] || { cat "$cwd/err"; fail "zero: exit $CODE"; }
scale=$(grep -n 'ecs update-service .*--desired-count 1' "$STUB_LOG" | head -1 | cut -d: -f1)
create=$(grep -n 'deploy create-deployment' "$STUB_LOG" | head -1 | cut -d: -f1)
[ -n "$scale" ] && [ -n "$create" ] && [ "$scale" -lt "$create" ] || fail "zero: update-service must precede create-deployment"
echo "ok: scales a service at zero to one before deploying"

# registers the app container at the digest with VERSION=sha
cwd="$root/succeeded"
jq -e --arg img "reg.example/zdp/app@$DIGEST" --arg sha "$SHA" '
  (.containerDefinitions[] | select(.name == "app")) as $a
  | $a.image == $img
  and ([$a.environment[] | select(.name == "VERSION")] == [{name: "VERSION", value: $sha}])
  and ([$a.environment[] | select(.name == "PORT")] | length == 1)
  and ((.containerDefinitions[] | select(.name == "sidecar") | .image) == "keep")
  and (has("taskDefinitionArn") | not)' "$cwd/registered.json" >/dev/null || fail "registered task definition wrong: $(cat "$cwd/registered.json")"
echo "ok: registers the app container at the digest with VERSION=sha"
echo PASS
