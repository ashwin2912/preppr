#!/bin/sh
# Nightly: pg_dump (custom format) of DATABASE_URL → r2:$R2_BUCKET/preppr/, then
# delete dumps older than BACKUP_KEEP_DAYS. `docker compose ... run --rm backup now`
# takes one immediately. Restore: docs/runbook.md.
set -eu

if [ -z "${R2_BUCKET:-}" ] || [ -z "${RCLONE_CONFIG_R2_ACCESS_KEY_ID:-}" ] || [ -z "${RCLONE_CONFIG_R2_SECRET_ACCESS_KEY:-}" ] || [ "${RCLONE_CONFIG_R2_ENDPOINT:-}" = "https://.r2.cloudflarestorage.com" ]; then
  while true; do echo "backup DISABLED: set R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env" >&2; [ "${1:-}" = "now" ] && exit 1; sleep 3600; done
fi

apk add --no-cache rclone ca-certificates >/dev/null

# sslmode=verify-full (Neon's default) needs a CA; use the system store.
case "$DATABASE_URL" in
  *sslrootcert=*) ;;
  *\?*) DATABASE_URL="$DATABASE_URL&sslrootcert=system" ;;
  *) DATABASE_URL="$DATABASE_URL?sslrootcert=system" ;;
esac

dump() {
  f="/tmp/preppr-$(date +%Y%m%d-%H%M%S).dump"
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f "$f"
  rclone copyto "$f" "r2:$R2_BUCKET/preppr/$(basename "$f")"
  rm -f "$f"
  rclone delete --min-age "${BACKUP_KEEP_DAYS}d" "r2:$R2_BUCKET/preppr/"
  echo "backup ok: $(basename "$f")"
}

if [ "${1:-}" = "now" ]; then dump; exit 0; fi

while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $BACKUP_AT" +%s 2>/dev/null || date -D "%Y-%m-%d %H:%M" -d "$(date +%Y-%m-%d) $BACKUP_AT" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  dump || echo "backup FAILED" >&2
done
