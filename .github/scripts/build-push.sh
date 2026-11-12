#!/usr/bin/env bash
# Builds and pushes this commit's image once, or reuses it if a previous run
# already pushed it (ECR tags are immutable, so a re-run must not try to push
# again). Prints the release JSON on stdout; logs to stderr.
# Usage: build-push.sh <sha> <registry>
#
# The layer cache lives in ECR (zdp/buildcache:app), not the GitHub Actions
# cache: that is capped at 10 GB per repo, and near the cap a push of layers
# ECR already held stalled for 952 s.
set -euo pipefail
SHA="$1"; REGISTRY="$2"
export BUILDKIT_PROGRESS=plain
CACHE="$REGISTRY/zdp/buildcache:app"
# Metadata files go OUTSIDE the build context (the cwd): the Dockerfile may
# `COPY . .`, so a file written there changes the context and busts the layer
# cache. build-push.test.sh guards this.
META=$(mktemp -d "${RUNNER_TEMP:-/tmp}/build-push.XXXXXX")

d=$(aws ecr describe-images --repository-name zdp/app --image-ids "imageTag=$SHA" \
      --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true)
if [ -n "$d" ] && [ "$d" != "None" ]; then
  echo "::notice::zdp/app:$SHA already in ECR ($d); not rebuilding" >&2
else
  # The push, with the cache export, bounded so a stall fails loudly.
  for attempt in 1 2; do
    started=$SECONDS
    if timeout 600 docker buildx build --platform linux/amd64 -f Dockerfile \
         --provenance=false \
         --cache-from "type=registry,ref=$CACHE" \
         --cache-to "type=registry,ref=$CACHE,mode=max,image-manifest=true,oci-mediatypes=true" \
         --output "type=image,name=$REGISTRY/zdp/app:$SHA,push=true" \
         --metadata-file "$META/meta-app.json" . >&2; then
      echo "::notice::zdp/app pushed in $((SECONDS - started)) s (attempt $attempt)" >&2
      break
    fi
    if [ "$attempt" = 2 ]; then
      echo "::error::zdp/app: build and push failed or exceeded 600 s twice" >&2
      exit 1
    fi
    echo "::warning::zdp/app: build and push failed or exceeded 600 s; retrying once" >&2
  done
  d=$(jq -er '."containerimage.digest"' "$META/meta-app.json")
fi
jq -n --arg sha "$SHA" --arg d "$d" '{sha: $sha, digests: {app: $d}}'
