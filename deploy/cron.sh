#!/usr/bin/env bash
# Linux installer. Only manage the marked Batam block in root's crontab.
batam_cron_timezone() {
  local unit pid timezone="" system_timezone
  for unit in cron crond; do
    if systemctl is-active --quiet "$unit"; then break; fi
    unit=""
  done
  [[ -n $unit ]] || { printf 'No active cron/crond daemon\n' >&2; return 1; }
  pid="$(systemctl show "$unit" --property=MainPID --value)"
  [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/environ ]] || { printf 'Cannot inspect cron daemon timezone\n' >&2; return 1; }
  timezone="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^TZ=//p')"
  if [[ -z $timezone ]]; then
    system_timezone="$(timedatectl show --property=Timezone --value)" || return 1
    # Debian cron may read /etc/timezone; reject inconsistent host settings.
    if [[ -f /etc/timezone ]]; then
      timezone="$(tr -d '\n\r' < /etc/timezone)"
      case "$timezone" in Etc/UTC|Etc/GMT|GMT) timezone=UTC ;; esac
      case "$system_timezone" in Etc/UTC|Etc/GMT|GMT) system_timezone=UTC ;; esac
      [[ $timezone == "$system_timezone" ]] || { printf 'Host timezone settings disagree\n' >&2; return 1; }
    fi
    timezone="$system_timezone"
  fi
  case "$timezone" in
    UTC|Etc/UTC|GMT|Etc/GMT) printf 'UTC\n' ;;
    Asia/Ho_Chi_Minh) printf 'Asia/Ho_Chi_Minh\n' ;;
    *) printf 'Unsupported cron daemon timezone: %s (expected UTC or Asia/Ho_Chi_Minh)\n' "$timezone" >&2; return 1 ;;
  esac
}

batam_setup_cron() (
  set -euo pipefail
  local app_dir="$1" env_file="$2" port="$3" release="$4"
  local start='# BEGIN BATAM CRON' end='# END BATAM CRON'
  local temporary timezone schedule job_id command_line
  for tool in crontab node curl systemctl; do command -v "$tool" >/dev/null || { printf 'Missing %s\n' "$tool" >&2; return 1; }; done
  [[ $(id -u) == 0 ]] || { printf 'Cron installation requires root\n' >&2; return 1; }
  # A literal percent has special meaning in crontab, even inside shell quotes.
  for value in "$app_dir" "$env_file"; do
    [[ $value == /* && $value != *%* && $value != *$'\n'* && $value != *$'\r'* ]] || { printf 'Unsupported cron path\n' >&2; return 1; }
  done
  [[ $port =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 64535 )) || return 1
  umask 077
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' EXIT
  if ! LC_ALL=C crontab -l > "$temporary/old" 2> "$temporary/error"; then
    # A missing crontab is expected; other read failures must not erase entries.
    if ! LC_ALL=C grep -qi 'no crontab for' "$temporary/error"; then
      cat "$temporary/error" >&2; return 1
    fi
  fi
  awk -v start="$start" -v end="$end" '
    $0 == start { if (inside || seen++) exit 1; inside=1; next }
    $0 == end { if (!inside) exit 1; inside=0; next }
    !inside { print }
    END { if (inside) exit 1 }
  ' "$temporary/old" > "$temporary/new" || { printf 'Malformed Batam cron block\n' >&2; return 1; }

  # Cronie can inherit CRON_TZ from unrelated entries, overriding daemon time.
  # Do not change other jobs' environment or silently schedule Batam incorrectly.
  if [[ -f $release/src/lib/cron/schedules.json ]] && grep -Eq '^[[:space:]]*CRON_TZ[[:space:]]*=' "$temporary/new"; then
    printf 'Existing crontab sets CRON_TZ; resolve this override before installing Batam cron\n' >&2
    return 1
  fi

  # Rolling back to a release before cron support removes only our block.
  if [[ -f $release/src/lib/cron/schedules.json ]]; then
    [[ -f $release/deploy/run-cron.sh ]] || return 1
    [[ -f $env_file ]] || return 1
    chmod 600 "$env_file"
    # Same trusted shell env contract as deploy.sh; never print secret values.
    # shellcheck disable=SC1090
    source "$env_file"
    [[ -n ${CRON_SECRET:-} && -n ${LARK_WEBHOOK_URL:-} ]] || { printf 'Set CRON_SECRET and LARK_WEBHOOK_URL before installing cron\n' >&2; return 1; }
    [[ $CRON_SECRET != *$'\n'* && $CRON_SECRET != *$'\r'* ]] || return 1
    timezone="$(batam_cron_timezone)" || return 1
    node "$release/deploy/cron-schedules.mjs" "$release/src/lib/cron/schedules.json" "$timezone" > "$temporary/schedules"
    printf '%s\n' "$start" >> "$temporary/new"
    while IFS=$'\t' read -r schedule job_id; do
      printf -v command_line '/bin/bash %q %q %q %q %q' "$app_dir/current/deploy/run-cron.sh" "$app_dir" "$env_file" "$port" "$job_id"
      # %q uses bash escaping, so explicitly choose bash for this command only.
      printf '%s /bin/bash -c %q\n' "$schedule" "$command_line" >> "$temporary/new"
    done < "$temporary/schedules"
    printf '%s\n' "$end" >> "$temporary/new"
  fi
  crontab "$temporary/new"
  crontab -l > "$temporary/installed"
  cmp -s "$temporary/new" "$temporary/installed" || { printf 'Cron verification failed\n' >&2; return 1; }
  printf 'Batam cron synchronized with active release\n'
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  batam_setup_cron "$@"
fi
