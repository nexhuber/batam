#!/usr/bin/env bash
# Deploy Batam from Git on the VPS. Uploads through push.sh share install.sh.
set -euo pipefail

APP_DIR="${BATAM_APP_DIR:-/var/www/html/batam}"
REPO_URL="${BATAM_GIT_URL:-https://github.com/nexhuber/batam.git}"
BRANCH="${BATAM_GIT_BRANCH:-main}"
PORT="${BATAM_PORT:-3200}"
SERVICE=batam-dashboard

usage() {
  cat <<'EOF'
Batam deploy on VPS
Usage: sudo BATAM_DOMAIN=your.domain deploy/deploy.sh [command]

  (no command)   Fetch origin/main and deploy a new release
  --setup        Clone the Git repository if needed, then deploy
  --rollback     Restore the previous healthy release
  --status       Show active release, service and health
  --history      Show recent deploy and rollback records
  --logs         Show recent systemd logs
  -h, --help     Show this help

Defaults: BATAM_APP_DIR=/var/www/html/batam, BATAM_PORT=3200,
          BATAM_GIT_BRANCH=main, BATAM_GIT_URL=https://github.com/nexhuber/batam.git
Set BATAM_ENV_SOURCE only for the first deploy if Batam .env does not exist.
EOF
}
die() { echo "$*" >&2; exit 1; }
root_required() { [[ $EUID -eq 0 ]] || die "Run this command with sudo"; }
current() {
  if [[ -L $APP_DIR/current ]]; then readlink -f "$APP_DIR/current"; fi
}
healthy() {
  local i
  for i in {1..20}; do
    if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then return 0; fi
    sleep 2
  done
  return 1
}
switch_to() {
  ln -sfn "$1" "$APP_DIR/current.new"
  mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
}
repository() {
  if [[ -d $APP_DIR/repo.git ]]; then
    echo "$APP_DIR/repo.git"
  elif [[ -d $APP_DIR/source/.git ]]; then
    echo "$APP_DIR/source"
  elif [[ -d $APP_DIR/.git ]]; then
    echo "$APP_DIR"
  else
    die "No VPS Git repository found; run --setup or set up origin in $APP_DIR/source"
  fi
}
deploy() {
  root_required
  [[ -n ${BATAM_DOMAIN:-} ]] || die "Set BATAM_DOMAIN to Batam's public hostname"
  for tool in git tar mktemp; do command -v "$tool" >/dev/null || die "Missing $tool"; done
  local repo stage commit release_id
  repo="$(repository)"
  git -C "$repo" fetch origin "$BRANCH"
  commit="$(git -C "$repo" rev-parse --verify FETCH_HEAD^{commit})"
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:8}"
  stage="$(mktemp -d /tmp/batam-git.XXXXXXXX)"
  trap "rm -rf -- '$stage'" EXIT
  git -C "$repo" archive "$commit" | tar -x -C "$stage"
  BATAM_RELEASE_ID="$release_id" bash "$stage/deploy/install.sh" "$stage"
  echo "Deployed Git commit $commit"
}
setup() {
  root_required
  if [[ ! -d $APP_DIR/repo.git && ! -d $APP_DIR/source/.git && ! -d $APP_DIR/.git ]]; then
    mkdir -p "$APP_DIR"
    git clone --bare "$REPO_URL" "$APP_DIR/repo.git"
  fi
  deploy
}
rollback() {
  root_required
  local previous before
  [[ -L $APP_DIR/previous ]] || die "No previous release available"
  previous="$(readlink -f "$APP_DIR/previous")"
  before="$(current)"
  [[ -n $before && -d $previous && $previous == "$APP_DIR/releases/"* ]] || die "Rollback target is missing or invalid"
  [[ $previous != $before ]] || die "Previous release is already active"
  switch_to "$previous"
  if ! systemctl restart "$SERVICE" || ! healthy; then
    switch_to "$before"
    systemctl restart "$SERVICE" || true
    healthy || echo "Original release health check failed; inspect journalctl -u $SERVICE" >&2
    die "Rollback failed; restored $before"
  fi
  ln -sfn "$before" "$APP_DIR/previous"
  printf '%s,rollback,%s,%s\n' "$(date -u +%FT%TZ)" "${previous##*/}" "${before##*/}" >> "$APP_DIR/.deploy_history"
  echo "Rolled back to ${previous##*/}"
}
status() {
  echo "Current: ${APP_DIR}/current -> $(current)"
  if [[ -L $APP_DIR/previous ]]; then echo "Previous: $(readlink -f "$APP_DIR/previous")"; fi
  if command -v systemctl >/dev/null && systemctl is-active --quiet "$SERVICE"; then echo "Service: active"; else echo "Service: inactive"; fi
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then
    echo "Health: ok (127.0.0.1:$PORT)"
  else
    echo "Health: failed (127.0.0.1:$PORT)"
  fi
}

case "${1:-}" in
  "") deploy ;;
  --setup) setup ;;
  --rollback) rollback ;;
  --status) status ;;
  --history) if [[ -f $APP_DIR/.deploy_history ]]; then tail -n 20 "$APP_DIR/.deploy_history"; else echo "No deployment history"; fi ;;
  --logs) journalctl -u "$SERVICE" -n 50 --no-pager ;;
  -h|--help|help) usage ;;
  *) die "Unknown option: $1" ;;
esac
