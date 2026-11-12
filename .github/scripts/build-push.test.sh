#!/usr/bin/env bash
# Tests build-push.sh against stubbed docker and aws (no network, no AWS).
# Run: bash .github/scripts/build-push.test.sh   (bash 3.2+ and jq)
#
# The guard that matters: the build must see the same context every time and
# the script must leave nothing in it. A file written into the context busts
# the layer cache.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

mkdir -p "$work/bin" "$work/ctx"
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Records the context listing (the cwd, which build-push.sh passes as ".")
# and writes a metadata file.
echo "context: $(find . -mindepth 1 -maxdepth 1 | sort | tr '\n' ' ')" >> "$STUB_LOG"
echo "docker $*" >> "$STUB_LOG"
meta=""; prev=""
for a in "$@"; do
  [ "$prev" = "--metadata-file" ] && meta=$a
  prev=$a
done
printf '{"containerimage.digest":"sha256:%064d"}' 7 > "$meta"
STUB
cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_LOG"
case "$*" in *imageTag=*) echo None ;; esac
STUB
# macOS has no timeout(1); CI does. The stub just runs the command.
cat > "$work/bin/timeout" <<'STUB'
#!/usr/bin/env bash
shift
exec "$@"
STUB
chmod +x "$work/bin/docker" "$work/bin/aws" "$work/bin/timeout"

touch "$work/ctx/package.json" "$work/ctx/Dockerfile"
export STUB_LOG="$work/log"
: > "$STUB_LOG"
before=$(cd "$work/ctx" && find . -mindepth 1 -maxdepth 1 | sort | tr '\n' ' ')
(cd "$work/ctx" && PATH="$work/bin:$PATH" bash "$here/build-push.sh" abc123 reg.example > "$work/out" 2> "$work/err") \
  || { cat "$work/err"; fail "build-push.sh exited non-zero"; }

builds=$(grep -c '^docker ' "$STUB_LOG")
[ "$builds" = 1 ] || fail "expected 1 build, got $builds"
grep -q -- '-f Dockerfile' "$STUB_LOG" || fail "build does not use -f Dockerfile"
grep -q -- '--target' "$STUB_LOG" && fail "build must not use --target"
contexts=$(grep '^context: ' "$STUB_LOG" | sort -u | wc -l | tr -d ' ')
[ "$contexts" = 1 ] || fail "the build context changed between builds"
[ "$(grep '^context: ' "$STUB_LOG" | sed 's/^context: //')" = "$before" ] || fail "context differs from the checkout"
after=$(cd "$work/ctx" && find . -mindepth 1 -maxdepth 1 | sort | tr '\n' ' ')
[ "$after" = "$before" ] || fail "build-push.sh left files in the build context: $after"
jq -e '.sha == "abc123" and (.digests | keys == ["app"]) and (.digests.app | test("^sha256:[0-9a-f]{64}$"))' "$work/out" >/dev/null \
  || fail "release JSON is malformed: $(cat "$work/out")"
echo "ok: one build, context unchanged, nothing left in context, valid release JSON"
echo PASS
