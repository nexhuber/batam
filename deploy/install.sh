#!/usr/bin/env bash
# Shared release installer for Git deploys and uploads from push.sh.
set -euo pipefail

SOURCE_DIR="${1:?Usage: sudo BATAM_DOMAIN=... bash deploy/install.sh SOURCE_DIR}"
DOMAIN="${BATAM_DOMAIN:?BATAM_DOMAIN is required}"
PORT="${BATAM_PORT:-3200}"
APP_DIR="${BATAM_APP_DIR:-/var/www/html/batam}"
ENV_SOURCE="${BATAM_ENV_SOURCE:-}"
KEEP_RELEASES="${BATAM_KEEP_RELEASES:-5}"
RELEASE_ID="${BATAM_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-upload}"
SYSTEMD_DIR="${BATAM_SYSTEMD_DIR:-/etc/systemd/system}"
NGINX_AVAILABLE="${BATAM_NGINX_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_ENABLED="${BATAM_NGINX_ENABLED:-/etc/nginx/sites-enabled}"
SERVICE=batam-dashboard

die() { echo "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run this script with sudo"
[[ $DOMAIN =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || die "Invalid BATAM_DOMAIN"
[[ $PORT =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 64535 )) || die "Invalid BATAM_PORT"
[[ $KEEP_RELEASES =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 )) || die "BATAM_KEEP_RELEASES must be at least 2"
[[ $RELEASE_ID =~ ^[a-zA-Z0-9._-]+$ ]] || die "Invalid BATAM_RELEASE_ID"
for tool in node yarn rsync nginx systemctl curl ss sudo mktemp; do
  command -v "$tool" >/dev/null || die "Missing $tool"
done
node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>20||(v[0]===20&&v[1]>=9)?0:1)' || die "Node.js 20.9+ is required"
[[ $(yarn --version) == 1.* ]] || die "Yarn 1 is required"
[[ -f $SOURCE_DIR/yarn.lock && -f $SOURCE_DIR/package.json && -f $SOURCE_DIR/deploy/batam-dashboard.service.template ]] || die "Source tree is incomplete"
[[ -d $NGINX_AVAILABLE && -d $NGINX_ENABLED && -d $SYSTEMD_DIR ]] || die "Nginx/systemd directories are missing"
id www-data >/dev/null || die "www-data user is missing"

mkdir -p "$APP_DIR/releases"
chmod 755 "$APP_DIR" "$APP_DIR/releases"
ENV_FILE="$APP_DIR/.env"
if [[ ! -f $ENV_FILE ]]; then
  [[ -n $ENV_SOURCE && -f $ENV_SOURCE ]] || die "Create $ENV_FILE or set BATAM_ENV_SOURCE to an existing server env file"
  umask 077
  ENV_TMP="$(mktemp "$APP_DIR/.env.tmp.XXXXXXXX")"
  if ! (
    # Only copy Batam settings; never carry a different app's PORT or service config.
    # shellcheck disable=SC1090
    source "$ENV_SOURCE"
    for key in SESSION_SECRET LARK_APP_ID LARK_APP_SECRET BQ_PROJECT BQ_DATASET BQ_LOCATION MONARCH_API_BASE_URL BRAND_PIVOT_API_TOKEN; do
      [[ -n ${!key:-} ]] || die "Missing $key in BATAM_ENV_SOURCE"
      printf '%s=%q\n' "$key" "${!key}"
    done
    printf 'LARK_REDIRECT_URI=%q\n' "https://${DOMAIN}/auth/callback"
    for key in GOOGLE_APPLICATION_CREDENTIALS LARK_BASE_URL; do
      if [[ -n ${!key:-} ]]; then printf '%s=%q\n' "$key" "${!key}"; fi
    done
  ) > "$ENV_TMP"; then
    rm -f "$ENV_TMP"
    exit 1
  fi
  mv -f "$ENV_TMP" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
# Ignore a stray PORT in an imported env; the service and checks use BATAM_PORT.
PORT="${BATAM_PORT:-3200}"
for key in SESSION_SECRET LARK_APP_ID LARK_APP_SECRET BQ_PROJECT BQ_DATASET BQ_LOCATION MONARCH_API_BASE_URL BRAND_PIVOT_API_TOKEN; do
  [[ -n ${!key:-} ]] || die "Missing $key in $ENV_FILE"
done
[[ ${LARK_REDIRECT_URI:-} == "https://${DOMAIN}/auth/callback" ]] || die "LARK_REDIRECT_URI must equal https://${DOMAIN}/auth/callback"
if [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} ]]; then
  [[ $GOOGLE_APPLICATION_CREDENTIALS == /* ]] || die "GOOGLE_APPLICATION_CREDENTIALS must be an absolute path outside releases"
  [[ $GOOGLE_APPLICATION_CREDENTIALS != "$APP_DIR/releases/"* ]] || die "GOOGLE_APPLICATION_CREDENTIALS must be outside releases"
  sudo -u www-data test -r "$GOOGLE_APPLICATION_CREDENTIALS" || die "BigQuery credential file is not readable by www-data"
fi
if ss -ltn "( sport = :$PORT )" | grep -qvE '^(State|Netid)'; then
  systemctl is-active --quiet "$SERVICE" || die "Port $PORT is already in use by another service"
fi

RELEASE="$APP_DIR/releases/$RELEASE_ID"
[[ ! -e $RELEASE ]] || die "Release already exists: $RELEASE"
mkdir "$RELEASE"
rsync -a --exclude='.git' --exclude='.env*' --exclude='node_modules' --exclude='.next' --exclude='*.tsbuildinfo' "$SOURCE_DIR/" "$RELEASE/"
cd "$RELEASE"
yarn install --frozen-lockfile --non-interactive
NODE_ENV=production yarn build
chown -R www-data:www-data "$RELEASE"

NODE_BIN="$(command -v node)"
sudo -u www-data "$NODE_BIN" --version >/dev/null || die "Node.js at $NODE_BIN is not executable by www-data"

# Probe the new build before touching the running service or Nginx.
TEST_PORT=$((PORT + 1000))
if ss -ltn "( sport = :$TEST_PORT )" | grep -qvE '^(State|Netid)'; then
  die "Temporary health-check port $TEST_PORT is occupied"
fi
NODE_ENV=production PORT="$TEST_PORT" HOSTNAME=127.0.0.1 "$NODE_BIN" "$RELEASE/node_modules/next/dist/bin/next" start -p "$TEST_PORT" -H 127.0.0.1 > "$APP_DIR/.preflight.log" 2>&1 &
TEST_PID=$!
stop_test() {
  kill "$TEST_PID" 2>/dev/null || true
  wait "$TEST_PID" 2>/dev/null || true
}
trap stop_test EXIT
ready=0
for _ in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:${TEST_PORT}/api/health" | grep -q '"status":"ok"'; then ready=1; break; fi
  kill -0 "$TEST_PID" 2>/dev/null || break
  sleep 1
done
(( ready == 1 )) || die "Pre-deploy health check failed; see $APP_DIR/.preflight.log"
stop_test
trap - EXIT

# Prepare service and site before the release switch. Existing Certbot edits are retained.
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__PORT__|$PORT|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
  "$SOURCE_DIR/deploy/batam-dashboard.service.template" > "$SYSTEMD_DIR/$SERVICE.service"
if [[ ! -e $NGINX_AVAILABLE/$SERVICE ]]; then
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" \
    "$SOURCE_DIR/deploy/nginx.conf.template" > "$NGINX_AVAILABLE/$SERVICE"
fi
grep -Eq "server_name[[:space:]]+$DOMAIN;" "$NGINX_AVAILABLE/$SERVICE" || die "Existing Nginx site does not serve $DOMAIN"
grep -Fq "proxy_pass http://127.0.0.1:$PORT;" "$NGINX_AVAILABLE/$SERVICE" || die "Existing Nginx site does not proxy to port $PORT"
ln -sfn "$NGINX_AVAILABLE/$SERVICE" "$NGINX_ENABLED/$SERVICE"
nginx -t
systemctl daemon-reload
systemctl enable "$SERVICE"

PREVIOUS=""
if [[ -L $APP_DIR/current ]]; then PREVIOUS="$(readlink -f "$APP_DIR/current")"; fi
switch_to() {
  ln -sfn "$1" "$APP_DIR/current.new"
  mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
}
healthy() {
  local i
  for i in {1..20}; do
    if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then return 0; fi
    sleep 2
  done
  return 1
}
restore_previous() {
  echo "Deploy failed; restoring previous release" >&2
  if [[ -n $PREVIOUS ]]; then
    switch_to "$PREVIOUS"
    systemctl restart "$SERVICE" || true
    healthy || echo "Previous release health check failed; inspect journalctl -u $SERVICE" >&2
  else
    systemctl stop "$SERVICE" || true
    rm -f "$APP_DIR/current"
  fi
  printf '%s,failed,%s,%s\n' "$(date -u +%FT%TZ)" "$RELEASE_ID" "${PREVIOUS##*/}" >> "$APP_DIR/.deploy_history"
}

switch_to "$RELEASE"
if ! systemctl restart "$SERVICE" || ! healthy; then
  restore_previous
  die "Batam failed post-deploy health check; see journalctl -u $SERVICE"
fi
if ! systemctl reload nginx; then
  restore_previous
  die "Nginx reload failed"
fi

if [[ -n $PREVIOUS ]]; then ln -sfn "$PREVIOUS" "$APP_DIR/previous"; fi
printf '%s,deploy,%s,%s\n' "$(date -u +%FT%TZ)" "$RELEASE_ID" "${PREVIOUS##*/}" >> "$APP_DIR/.deploy_history"

# Preserve both the live release and the immediate rollback target.
kept=0
protected=1
if [[ -L $APP_DIR/previous && $(readlink -f "$APP_DIR/previous") != "$(readlink -f "$APP_DIR/current")" ]]; then
  protected=2
fi
while IFS= read -r release_id; do
  candidate="$APP_DIR/releases/$release_id"
  if [[ $candidate == "$(readlink -f "$APP_DIR/current")" || ( -L $APP_DIR/previous && $candidate == "$(readlink -f "$APP_DIR/previous")" ) ]]; then
    continue
  fi
  kept=$((kept + 1))
  if (( kept > KEEP_RELEASES - protected )); then rm -rf -- "$candidate"; fi
done < <(find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)

echo "Batam release $RELEASE_ID healthy at http://127.0.0.1:$PORT/api/health"
echo "Nginx site configured for $DOMAIN"
