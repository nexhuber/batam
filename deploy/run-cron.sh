#!/usr/bin/env bash
set -euo pipefail
umask 077
app_dir="${1:?app directory required}"
env_file="${2:?env file required}"
port="${3:?port required}"
job_id="${4:?job ID required}"
[[ $job_id =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || exit 1
[[ $port =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 64535 )) || exit 1
exec >> "$app_dir/.cron.log" 2>&1
printf '[%s] Starting %s\n' "$(date -u +%FT%TZ)" "$job_id"
# shellcheck disable=SC1090
source "$env_file"
[[ -n ${CRON_SECRET:-} && $CRON_SECRET != *$'\r'* && $CRON_SECRET != *$'\n'* ]] || { printf 'Invalid CRON_SECRET\n'; exit 1; }
# Supply the header on stdin instead of exposing the secret in process arguments.
# Do not retry this request: it includes both the database write and delivery.
if printf 'Authorization: Bearer %s\n' "$CRON_SECRET" | curl --silent --show-error --fail-with-body \
  --noproxy '*' --connect-timeout 10 --max-time 900 --request POST --header @- \
  "http://127.0.0.1:${port}/api/cron/${job_id}"; then
  printf '\n[%s] Completed %s\n' "$(date -u +%FT%TZ)" "$job_id"
else
  result=$?
  printf '\n[%s] Failed %s (curl exit %s)\n' "$(date -u +%FT%TZ)" "$job_id" "$result"
  exit "$result"
fi
