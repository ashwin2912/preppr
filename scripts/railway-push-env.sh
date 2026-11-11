#!/bin/sh
# Usage: sh scripts/railway-push-env.sh [.env.assistant]   (run from the repo root, after `railway link`)
# Values go in through stdin, so they never appear in the terminal or shell history. Deploy after with `railway up` (not `railway redeploy`).
# Push KEY=VALUE lines from an env file to the linked Railway service without printing values.
# Refuses if any <placeholder> is left.
set -e
f="${1:-.env.assistant}"
if grep -Eq '^[A-Z_]+=.*<' "$f"; then
  echo "unfilled:"; grep -Eo '^[A-Z_]+=.*<' "$f" | cut -d= -f1
  exit 1
fi
grep -E '^[A-Z_]+=' "$f" | while IFS= read -r line; do
  key=${line%%=*}
  val=${line#*=}
  val=$(printf %s "$val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')
  printf %s "$val" | railway variable set "$key" --stdin --skip-deploys >/dev/null
  echo "set $key"
done
