#!/usr/bin/env bash
# scripts/drill-traffic.sh
# Steady traffic for the canary drill (README, Drills): about 5 requests a
# second against <url>, with a running count of response codes, so the
# environment's 5xx alarm has enough requests to fire during the canary.
# Usage: scripts/drill-traffic.sh <url> [seconds=360]
set -euo pipefail
URL="${1:?usage: scripts/drill-traffic.sh <url> [seconds=360]}"
DURATION="${2:-360}"

CODES=$(mktemp)
trap 'rm -f "$CODES"' EXIT

# Count codes in the log matching <pattern>; grep exits 1 on zero matches.
count() { grep -c "$1" "$CODES" || true; }

show() {
  printf '\r%4ss left  2xx %-6s 4xx %-6s 5xx %-6s no response %-6s' \
    "$1" "$(count '^2')" "$(count '^4')" "$(count '^5')" "$(count '^000')"
}

end=$((SECONDS + DURATION))
shown=-1
while [ "$SECONDS" -lt "$end" ]; do
  # One request every 0.2 s, each in the background so a slow response does
  # not lower the rate. curl prints 000 when it gets no response at all.
  { curl -s -o /dev/null -m 2 -w '%{http_code}\n' "$URL" || true; } >>"$CODES" &
  # Redraw the counts once a second; counting on every tick slows the loop.
  if [ "$SECONDS" -ne "$shown" ]; then
    shown=$SECONDS
    show "$((end - SECONDS))"
  fi
  sleep 0.2
done
wait
show 0
printf '\n'
