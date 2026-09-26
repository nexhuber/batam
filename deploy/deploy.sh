#!/usr/bin/env bash
# Batam release manager. Build a fetched Git commit before switching the service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [[ ${PROJECT_DIR##*/} == current && -L $PROJECT_DIR ]]; then
  PROJECT_DIR="$(dirname "$PROJECT_DIR")"
fi
if [[ $(uname) == Linux ]] && command -v systemctl >/dev/null 2>&1; then
  DEFAULT_PM=systemd
  DEFAULT_APP_DIR=/var/www/html/batam
else
  DEFAULT_PM='nohup'
  DEFAULT_APP_DIR="$PROJECT_DIR"
fi

PM="${BATAM_PM:-$DEFAULT_PM}"
APP_DIR="${BATAM_APP_DIR:-$DEFAULT_APP_DIR}"
REPO_URL="${BATAM_GIT_URL:-https://github.com/nexhuber/batam.git}"
BRANCH="${BATAM_GIT_BRANCH:-main}"
PORT="${BATAM_PORT:-3105}"
KEEP_RELEASES="${BATAM_KEEP_RELEASES:-5}"
SERVICE=batam
LEGACY_SERVICE=batam-dashboard
NGINX_SITE=batam-dashboard
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
PREVIOUS_LINK="$APP_DIR/previous"
ENV_FILE="${BATAM_ENV_FILE:-$APP_DIR/.env}"
SYSTEMD_DIR="${BATAM_SYSTEMD_DIR:-/etc/systemd/system}"
NGINX_AVAILABLE="${BATAM_NGINX_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_ENABLED="${BATAM_NGINX_ENABLED:-/etc/nginx/sites-enabled}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
STAGE=""
TEST_PID=""
LOCK_DIR=""

usage() {
  cat <<'EOF'
Batam Deploy
Usage: deploy/deploy.sh [command]

  (no command)   Fetch origin/main and deploy a release
  --setup        Clone the repository if needed, then deploy
  --rollback     Restore the previous healthy release
  --status       Show release, process and health
  --history      Show recent deployment records
  --logs         Show deploy and service logs
  --configure-web  Configure Nginx and HTTPS for the current release
  -h, --help     Show this help

VPS defaults: BATAM_APP_DIR=/var/www/html/batam, BATAM_PM=systemd.
Local defaults: BATAM_APP_DIR=the project directory, BATAM_PM=nohup.
Both use BATAM_PORT=3105, BATAM_GIT_BRANCH=main and BATAM_KEEP_RELEASES=5.
On the VPS, set BATAM_DOMAIN for the Lark callback check, Nginx and TLS.
Set BATAM_CERTBOT_EMAIL when creating a new Certbot account.
EOF
}

die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }
log() {
  local line
  line="[$(date '+%H:%M:%S')] $*"
  printf '%s\n' "$line"
  [[ -d $APP_DIR ]] && printf '%s\n' "$line" >> "$APP_DIR/.deploy.log"
}
require_root() { [[ $PM != systemd || $EUID -eq 0 ]] || die "Run systemd commands with sudo"; }
require_command() { command -v "$1" >/dev/null 2>&1 || die "Missing $1"; }

acquire_lock() {
  [[ -n $LOCK_DIR ]] && return 0
  local path="$APP_DIR/.deploy.lock"
  mkdir "$path" 2>/dev/null || die "Another deploy may be running; inspect $path before removing it"
  LOCK_DIR="$path"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

validate_config() {
  [[ $PM == systemd || $PM == nohup ]] || die "BATAM_PM must be systemd or nohup"
  [[ $APP_DIR == /* && $APP_DIR != / ]] || die "BATAM_APP_DIR must be an absolute directory"
  [[ $BRANCH =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ && $BRANCH != *..* ]] || die "Invalid BATAM_GIT_BRANCH"
  if [[ ! $PORT =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 64535 )); then die "BATAM_PORT must be 1024..64535"; fi
  if [[ ! $KEEP_RELEASES =~ ^[0-9]+$ ]] || (( KEEP_RELEASES < 2 )); then die "BATAM_KEEP_RELEASES must be at least 2"; fi
  if [[ -n ${BATAM_DOMAIN:-} ]]; then
    [[ $BATAM_DOMAIN =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || die "Invalid BATAM_DOMAIN"
  fi
  if [[ -n ${BATAM_CERTBOT_EMAIL:-} ]]; then
    [[ $BATAM_CERTBOT_EMAIL =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$ ]] || die "Invalid BATAM_CERTBOT_EMAIL"
  fi
}

release_path() {
  [[ -L $1 ]] || return 0
  local target release_root
  target="$(readlink -f "$1")" || return 1
  release_root="$(readlink -f "$RELEASES_DIR")" || return 1
  [[ $target == "$release_root/"* && -d $target ]] || die "Invalid release link: $1"
  printf '%s\n' "$target"
}

switch_to() {
  local temporary="$APP_DIR/.current-$$"
  ln -s "$1" "$temporary"
  if [[ $(uname) == Darwin ]]; then
    mv -fh "$temporary" "$CURRENT_LINK"
  else
    mv -Tf "$temporary" "$CURRENT_LINK"
  fi
}

record() { printf '%s,%s,%s,%s\n' "$(date -u +%FT%TZ)" "$1" "$2" "$3" >> "$APP_DIR/.deploy_history"; }

repository() {
  if [[ -d $APP_DIR/repo.git ]]; then
    printf '%s\n' "$APP_DIR/repo.git"
  elif [[ -d $APP_DIR/source/.git ]]; then
    printf '%s\n' "$APP_DIR/source"
  elif [[ -d $APP_DIR/.git ]]; then
    printf '%s\n' "$APP_DIR"
  else
    die "No Git repository in $APP_DIR; run --setup"
  fi
}

load_env() {
  if [[ ! -f $ENV_FILE ]]; then
    [[ -n ${BATAM_ENV_SOURCE:-} && -f ${BATAM_ENV_SOURCE:-} ]] || die "Create $ENV_FILE or set BATAM_ENV_SOURCE"
    local temporary
    umask 077
    temporary="$(mktemp "$APP_DIR/.env.tmp.XXXXXXXX")"
    if ! (
      # The source is a trusted server-side shell env file. Copy only Batam keys.
      # shellcheck disable=SC1090
      source "$BATAM_ENV_SOURCE"
      for key in SESSION_SECRET LARK_APP_ID LARK_APP_SECRET BQ_PROJECT BQ_DATASET BQ_LOCATION MONARCH_API_BASE_URL BRAND_PIVOT_API_TOKEN; do
        [[ -n ${!key:-} ]] || { printf 'Missing %s in BATAM_ENV_SOURCE\n' "$key" >&2; exit 1; }
        printf '%s=%q\n' "$key" "${!key}"
      done
      [[ -n ${BATAM_DOMAIN:-} ]] || { printf 'BATAM_DOMAIN is required when importing an env file\n' >&2; exit 1; }
      printf 'LARK_REDIRECT_URI=%q\n' "https://${BATAM_DOMAIN}/auth/callback"
      for key in GOOGLE_APPLICATION_CREDENTIALS LARK_BASE_URL; do
        if [[ -n ${!key:-} ]]; then printf '%s=%q\n' "$key" "${!key}"; fi
      done
    ) > "$temporary"; then
      rm -f "$temporary"
      die "Could not import BATAM_ENV_SOURCE"
    fi
    mv "$temporary" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  export PORT="$PORT" NODE_ENV=production
  for key in SESSION_SECRET LARK_APP_ID LARK_APP_SECRET LARK_REDIRECT_URI BQ_PROJECT BQ_DATASET BQ_LOCATION MONARCH_API_BASE_URL BRAND_PIVOT_API_TOKEN; do
    [[ -n ${!key:-} ]] || die "Missing $key in $ENV_FILE"
  done
  if [[ $PM == systemd ]]; then
    [[ -n ${BATAM_DOMAIN:-} ]] || die "Set BATAM_DOMAIN to Batam's public hostname"
    [[ $LARK_REDIRECT_URI == "https://${BATAM_DOMAIN}/auth/callback" ]] || die "LARK_REDIRECT_URI must equal https://${BATAM_DOMAIN}/auth/callback"
  fi
}

copy_credentials() {
  [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} ]] || return 0
  if [[ $GOOGLE_APPLICATION_CREDENTIALS == /* ]]; then
    [[ -r $GOOGLE_APPLICATION_CREDENTIALS ]] || die "Credential file is unreadable: $GOOGLE_APPLICATION_CREDENTIALS"
    local credential_real release_root
    credential_real="$(readlink -f "$GOOGLE_APPLICATION_CREDENTIALS")"
    release_root="$(readlink -f "$RELEASES_DIR")"
    [[ $credential_real != "$release_root/"* ]] || die "Credentials must be outside releases"
    if [[ $PM == systemd ]]; then
      sudo -u www-data test -r "$GOOGLE_APPLICATION_CREDENTIALS" || die "Credential file is unreadable by www-data"
    fi
    return 0
  fi
  [[ $GOOGLE_APPLICATION_CREDENTIALS =~ ^(\./)?credentials/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$ ]] || die "Relative credentials must be ./credentials/<file>.json"
  local name="${GOOGLE_APPLICATION_CREDENTIALS##*/}"
  [[ -f $APP_DIR/credentials/$name && -r $APP_DIR/credentials/$name ]] || die "Missing credential file: $APP_DIR/credentials/$name"
  install -d -m 750 "$1/credentials"
  install -m 600 "$APP_DIR/credentials/$name" "$1/credentials/$name"
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$1 )" | grep -qvE '^(State|Netid)'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    die "Install ss or lsof to check port availability"
  fi
}

health_check() {
  local port="$1" attempts="${2:-20}" i
  for (( i=0; i<attempts; i++ )); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/api/health" | grep -q '"status":"ok"'; then return 0; fi
    sleep 2
  done
  return 1
}

service_running() {
  if [[ $PM == systemd ]]; then
    systemctl is-active --quiet "$SERVICE"
  elif [[ -f $APP_DIR/.pid ]]; then
    kill -0 "$(cat "$APP_DIR/.pid")" 2>/dev/null
  else
    return 1
  fi
}

service_stop() {
  if [[ $PM == systemd ]]; then
    systemctl stop "$SERVICE"
  elif [[ -f $APP_DIR/.pid ]]; then
    local pid
    pid="$(cat "$APP_DIR/.pid")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      for _ in {1..10}; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$pid" 2>/dev/null; then
        printf 'Local process %s did not stop\n' "$pid" >&2
        return 1
      fi
    fi
    rm -f "$APP_DIR/.pid"
  fi
}

service_start() {
  if [[ $PM == systemd ]]; then
    systemctl restart "$SERVICE"
  else
    local node_bin
    service_stop || return 1
    node_bin="$(command -v node)"
    ( cd "$CURRENT_LINK" && exec nohup "$node_bin" node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 > "$APP_DIR/.service.log" 2>&1 ) &
    printf '%s\n' "$!" > "$APP_DIR/.pid"
  fi
}

install_service() {
  [[ $PM == systemd ]] || return 0
  [[ -d $SYSTEMD_DIR ]] || die "Missing systemd unit directory: $SYSTEMD_DIR"
  id www-data >/dev/null || die "Missing www-data user"
  local node_bin
  node_bin="$(command -v node)"
  sudo -u www-data "$node_bin" --version >/dev/null || die "Node.js is not executable by www-data"
  sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__ENV_FILE__|$ENV_FILE|g" \
      -e "s|__PORT__|$PORT|g" -e "s|__NODE_BIN__|$node_bin|g" \
      "$1/deploy/$SERVICE.service.template" > "$SYSTEMD_DIR/$SERVICE.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE"
}

migrate_legacy_service() {
  [[ $PM == systemd ]] || return 0
  # Stop/remove the previous Batam unit before checking port ownership. The
  # Nginx site name stays unchanged, so this migration only renames systemd.
  systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
  systemctl disable "$LEGACY_SERVICE" 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/$LEGACY_SERVICE.service"
  systemctl daemon-reload
}

https_healthy() {
  curl --fail --silent --max-time 10 --noproxy '*' \
    --resolve "$BATAM_DOMAIN:443:127.0.0.1" "https://$BATAM_DOMAIN/api/health" \
    | grep -q '"status":"ok"'
}

configure_web() {
  [[ $PM == systemd ]] || return 0
  [[ -n ${BATAM_DOMAIN:-} ]] || die "Set BATAM_DOMAIN before configuring Nginx"
  for tool in nginx certbot curl; do require_command "$tool"; done
  [[ -d $NGINX_AVAILABLE && -d $NGINX_ENABLED ]] || die "Nginx site directories are missing"
  local template="$1/deploy/nginx.conf.template" site="$NGINX_AVAILABLE/$NGINX_SITE"
  local enabled="$NGINX_ENABLED/$NGINX_SITE" temporary
  [[ -f $template ]] || die "Nginx template is missing: $template"
  if [[ ! -e $site ]]; then
    temporary="$(mktemp "$NGINX_AVAILABLE/$NGINX_SITE.tmp.XXXXXXXX")"
    sed -e "s|__DOMAIN__|$BATAM_DOMAIN|g" -e "s|__PORT__|$PORT|g" "$template" > "$temporary"
    chmod 644 "$temporary"
    mv "$temporary" "$site"
    log "Created Nginx site for $BATAM_DOMAIN"
  fi
  if ! grep -Eq "^[[:space:]]*server_name[[:space:]]+$BATAM_DOMAIN;" "$site"; then
    printf 'Existing Nginx site %s does not serve %s\n' "$site" "$BATAM_DOMAIN" >&2
    return 1
  fi
  if ! grep -Fq "proxy_pass http://127.0.0.1:$PORT;" "$site"; then
    printf 'Existing Nginx site %s does not proxy to port %s\n' "$site" "$PORT" >&2
    return 1
  fi
  if [[ -e $enabled && ! -L $enabled ]]; then
    printf 'Nginx enabled path is not a symlink: %s\n' "$enabled" >&2
    return 1
  fi
  ln -sfn "$site" "$enabled"
  nginx -t && systemctl reload nginx || return 1
  if https_healthy; then
    log "HTTPS certificate is valid for $BATAM_DOMAIN"
    return 0
  fi
  local options=(--nginx --non-interactive --agree-tos --redirect -d "$BATAM_DOMAIN")
  if [[ -n ${BATAM_CERTBOT_EMAIL:-} ]]; then options+=(-m "$BATAM_CERTBOT_EMAIL"); fi
  log "Issuing HTTPS certificate for $BATAM_DOMAIN"
  certbot "${options[@]}" || return 1
  nginx -t && systemctl reload nginx && https_healthy || return 1
  log "HTTPS healthy at https://$BATAM_DOMAIN/api/health"
}

stop_test() {
  if [[ -n $TEST_PID ]]; then
    kill "$TEST_PID" 2>/dev/null || true
    wait "$TEST_PID" 2>/dev/null || true
    TEST_PID=""
  fi
}

cleanup() {
  stop_test
  if [[ -n $STAGE ]]; then rm -rf -- "$STAGE"; fi
  if [[ -n $LOCK_DIR ]]; then rm -rf -- "$LOCK_DIR"; fi
}
trap cleanup EXIT

preflight_release() {
  local release="$1" test_port=$((PORT + 1000)) node_bin
  port_in_use "$test_port" && die "Temporary health-check port $test_port is occupied"
  node_bin="$(command -v node)"
  ( cd "$release" && exec "$node_bin" node_modules/next/dist/bin/next start -p "$test_port" -H 127.0.0.1 > "$APP_DIR/.preflight.log" 2>&1 ) &
  TEST_PID=$!
  if ! health_check "$test_port" 15; then
    die "Pre-deploy health check failed; see $APP_DIR/.preflight.log"
  fi
  stop_test
}

cleanup_releases() {
  local current previous kept=0 protected=1 candidate candidate_real
  current="$(release_path "$CURRENT_LINK")"
  previous="$(release_path "$PREVIOUS_LINK")"
  [[ -n $previous && $previous != "$current" ]] && protected=2
  while IFS= read -r candidate; do
    candidate_real="$(readlink -f "$candidate")"
    [[ $candidate_real == "$current" || $candidate_real == "$previous" ]] && continue
    kept=$((kept + 1))
    if (( kept > KEEP_RELEASES - protected )); then rm -rf -- "$candidate"; fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r)
}

deploy() {
  require_root
  for tool in git tar mktemp node yarn curl install; do require_command "$tool"; done
  [[ $(yarn --version) == 1.* ]] || die "Yarn 1 is required"
  node -e 'const [major, minor]=process.versions.node.split(".").map(Number);process.exit((major===20&&minor>=19)||(major===22&&minor>=13)||major>=24?0:1)' || die "Node.js 20.19+, 22.13+ or 24+ is required"
  mkdir -p "$RELEASES_DIR"
  acquire_lock
  load_env
  local repo commit release_id release previous
  repo="$(repository)"
  log "Fetching origin/$BRANCH"
  git -C "$repo" fetch origin "$BRANCH"
  commit="$(git -C "$repo" rev-parse --verify 'FETCH_HEAD^{commit}')"
  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/batam-git.XXXXXXXX")"
  git -C "$repo" archive "$commit" | tar -x -C "$STAGE"
  [[ -f $STAGE/yarn.lock && -f $STAGE/deploy/$SERVICE.service.template ]] || die "Fetched commit lacks deployment files"
  release="$(mktemp -d "$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:8}.XXXXXX")"
  release_id="${release##*/}"
  cp -R "$STAGE/." "$release/"
  copy_credentials "$release"
  log "Building $release_id"
  # Yarn 1 skips devDependencies when NODE_ENV=production; Next needs TypeScript to build.
  ( cd "$release" && yarn install --production=false --frozen-lockfile --non-interactive && yarn build )
  if [[ $PM == systemd ]]; then
    chown -R www-data:www-data "$release"
    if [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} && $GOOGLE_APPLICATION_CREDENTIALS != /* ]]; then
      sudo -u www-data test -r "$release/$GOOGLE_APPLICATION_CREDENTIALS" || die "Credentials are unreadable by www-data"
    fi
  fi
  preflight_release "$release"
  previous="$(release_path "$CURRENT_LINK")"
  migrate_legacy_service
  if port_in_use "$PORT" && ! service_running; then die "Port $PORT belongs to another process"; fi
  install_service "$release"
  log "Switching to $release_id"
  switch_to "$release"
  if ! service_start || ! health_check "$PORT"; then
    log "New release failed; restoring previous release"
    if [[ -n $previous ]]; then
      switch_to "$previous"
      service_start || true
      health_check "$PORT" || log "Previous release also failed health check"
    else
      service_stop || true
      rm -f "$CURRENT_LINK"
    fi
    record failed "$release_id" "${previous##*/}"
    die "Deploy failed; inspect --logs"
  fi
  if [[ -n $previous ]]; then ln -sfn "$previous" "$PREVIOUS_LINK"; fi
  record deploy "$release_id" "${previous##*/}"
  cleanup_releases
  if ! configure_web "$release"; then
    die "App is healthy, but HTTPS setup failed; inspect Nginx/Certbot and run --configure-web"
  fi
  log "Deployed $release_id ($commit) at $HEALTH_URL"
}

setup() {
  require_root
  mkdir -p "$APP_DIR"
  acquire_lock
  if [[ ! -d $APP_DIR/repo.git && ! -d $APP_DIR/source/.git && ! -d $APP_DIR/.git ]]; then
    require_command git
    git clone --bare "$REPO_URL" "$APP_DIR/repo.git"
  fi
  deploy
}

rollback() {
  require_root
  acquire_lock
  local target before
  target="$(release_path "$PREVIOUS_LINK")"
  before="$(release_path "$CURRENT_LINK")"
  [[ -n $target && -n $before && $target != "$before" ]] || die "No previous release available"
  load_env
  switch_to "$target"
  if ! service_start || ! health_check "$PORT"; then
    switch_to "$before"
    service_start || true
    health_check "$PORT" || log "Original release also failed health check"
    die "Rollback failed; restored ${before##*/}"
  fi
  ln -sfn "$before" "$PREVIOUS_LINK"
  record rollback "${target##*/}" "${before##*/}"
  log "Rolled back to ${target##*/}"
}

configure_current_web() {
  require_root
  [[ $PM == systemd ]] || die "Nginx configuration is available on systemd hosts only"
  local release
  release="$(release_path "$CURRENT_LINK")"
  [[ -n $release ]] || die "No active release to configure"
  acquire_lock
  health_check "$PORT" 1 || die "Batam service is not healthy at $HEALTH_URL"
  configure_web "$release" || die "HTTPS setup failed; inspect Nginx/Certbot"
}

status() {
  printf 'Current: %s\n' "$(release_path "$CURRENT_LINK")"
  printf 'Previous: %s\n' "$(release_path "$PREVIOUS_LINK")"
  printf 'Port: %s\nProcess manager: %s\n' "$PORT" "$PM"
  if service_running; then printf 'Service: active\n'; else printf 'Service: inactive\n'; fi
  if curl --fail --silent --max-time 2 "$HEALTH_URL" | grep -q '"status":"ok"'; then
    printf 'Health: ok (%s)\n' "$HEALTH_URL"
  else
    printf 'Health: failed (%s)\n' "$HEALTH_URL"
  fi
}

logs() {
  if [[ -f $APP_DIR/.deploy.log ]]; then tail -n 50 "$APP_DIR/.deploy.log"; fi
  if [[ $PM == systemd ]]; then
    journalctl -u "$SERVICE" -n 50 --no-pager
  elif [[ -f $APP_DIR/.service.log ]]; then
    tail -n 50 "$APP_DIR/.service.log"
  else
    printf 'No service log yet\n'
  fi
}

validate_config
case "${1:-}" in
  '') deploy ;;
  --setup) setup ;;
  --rollback) rollback ;;
  --status) status ;;
  --history) if [[ -f $APP_DIR/.deploy_history ]]; then tail -n 20 "$APP_DIR/.deploy_history"; else printf 'No deployment history\n'; fi ;;
  --logs) logs ;;
  --configure-web) configure_current_web ;;
  -h|--help|help) usage ;;
  *) die "Unknown option: $1" ;;
esac
