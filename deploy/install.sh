#!/usr/bin/env bash
# Run on an Ubuntu/Debian host after uploading this source tree.
set -euo pipefail

SOURCE_DIR="${1:?Usage: sudo BATAM_DOMAIN=... bash deploy/install.sh SOURCE_DIR}"
DOMAIN="${BATAM_DOMAIN:?BATAM_DOMAIN is required}"
PORT="${BATAM_PORT:-3200}"
APP_DIR="${BATAM_APP_DIR:-/var/www/html/batam}"
ENV_SOURCE="${BATAM_ENV_SOURCE:-}"
SERVICE=batam-dashboard

if [[ $EUID -ne 0 ]]; then echo "Run this script with sudo" >&2; exit 1; fi
if [[ ! $DOMAIN =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]]; then echo "Invalid BATAM_DOMAIN" >&2; exit 1; fi
if [[ ! $PORT =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then echo "Invalid BATAM_PORT" >&2; exit 1; fi
for tool in node yarn rsync nginx systemctl curl ss; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
if ! node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>20||(v[0]===20&&v[1]>=9)?0:1)'; then
  echo "Node.js 20.9+ is required" >&2
  exit 1
fi
if ! yarn --version | grep -q '^1\.'; then echo "Yarn 1 is required" >&2; exit 1; fi
if [[ ! -f $SOURCE_DIR/yarn.lock || ! -f $SOURCE_DIR/package.json ]]; then echo "Source tree is incomplete" >&2; exit 1; fi
if [[ ! -d /etc/nginx/sites-available || ! -d /etc/nginx/sites-enabled ]]; then echo "Nginx sites-available/sites-enabled layout is required" >&2; exit 1; fi
id www-data >/dev/null || { echo "www-data user is missing" >&2; exit 1; }

mkdir -p "$APP_DIR/releases"
chmod 755 "$APP_DIR" "$APP_DIR/releases"
ENV_FILE="$APP_DIR/.env"
if [[ ! -f $ENV_FILE ]]; then
  if [[ -z $ENV_SOURCE || ! -f $ENV_SOURCE ]]; then
    echo "Create $ENV_FILE or set BATAM_ENV_SOURCE to an existing server env file" >&2
    exit 1
  fi
  umask 077
  (
    # Keep the source file's PORT and other deployment variables isolated.
    # shellcheck disable=SC1090
    source "$ENV_SOURCE"
    : "${SESSION_SECRET:?Missing SESSION_SECRET}"
    : "${LARK_APP_ID:?Missing LARK_APP_ID}"
    : "${LARK_APP_SECRET:?Missing LARK_APP_SECRET}"
    : "${BQ_PROJECT:?Missing BQ_PROJECT}"
    : "${BQ_LOCATION:?Missing BQ_LOCATION}"
    printf 'SESSION_SECRET=%q\n' "$SESSION_SECRET"
    printf 'LARK_APP_ID=%q\n' "$LARK_APP_ID"
    printf 'LARK_APP_SECRET=%q\n' "$LARK_APP_SECRET"
    printf 'LARK_REDIRECT_URI=%q\n' "https://${DOMAIN}/auth/callback"
    printf 'BQ_PROJECT=%q\n' "$BQ_PROJECT"
    printf 'BQ_LOCATION=%q\n' "$BQ_LOCATION"
    if [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} ]]; then
      printf 'GOOGLE_APPLICATION_CREDENTIALS=%q\n' "$GOOGLE_APPLICATION_CREDENTIALS"
    fi
    if [[ -n ${LARK_BASE_URL:-} ]]; then printf 'LARK_BASE_URL=%q\n' "$LARK_BASE_URL"; fi
  ) > "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
for key in SESSION_SECRET LARK_APP_ID LARK_APP_SECRET BQ_PROJECT BQ_LOCATION; do
  if [[ -z ${!key:-} ]]; then echo "Missing $key in $ENV_FILE" >&2; exit 1; fi
done
if [[ ${LARK_REDIRECT_URI:-} != "https://${DOMAIN}/auth/callback" ]]; then
  echo "LARK_REDIRECT_URI must equal https://${DOMAIN}/auth/callback" >&2
  exit 1
fi
if [[ -n ${GOOGLE_APPLICATION_CREDENTIALS:-} ]] && ! sudo -u www-data test -r "$GOOGLE_APPLICATION_CREDENTIALS"; then
  echo "BigQuery credential file is not readable by www-data" >&2
  exit 1
fi
if ! ss -ltn "( sport = :$PORT )" | grep -qvE '^(State|Netid)'; then :; else
  if ! systemctl is-active --quiet "$SERVICE"; then
    echo "Port $PORT is already in use by another service" >&2
    exit 1
  fi
fi

RELEASE="$APP_DIR/releases/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RELEASE"
rsync -a --exclude='.git' --exclude='.env*' --exclude='node_modules' --exclude='.next' --exclude='*.tsbuildinfo' "$SOURCE_DIR/" "$RELEASE/"
cd "$RELEASE"
yarn install --frozen-lockfile --non-interactive
yarn build
chown -R www-data:www-data "$RELEASE"

NODE_BIN="$(command -v node)"
if ! sudo -u www-data "$NODE_BIN" --version >/dev/null; then
  echo "Node.js at $NODE_BIN is not executable by www-data" >&2
  exit 1
fi
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__PORT__|$PORT|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
  "$SOURCE_DIR/deploy/batam-dashboard.service.template" > "/etc/systemd/system/$SERVICE.service"
if [[ ! -e /etc/nginx/sites-available/$SERVICE ]]; then
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" \
    "$SOURCE_DIR/deploy/nginx.conf.template" > "/etc/nginx/sites-available/$SERVICE"
fi
ln -sfn "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
nginx -t

PREVIOUS=""
if [[ -L $APP_DIR/current ]]; then PREVIOUS="$(readlink -f "$APP_DIR/current")"; fi
ln -sfn "$RELEASE" "$APP_DIR/current.new"
mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
systemctl daemon-reload
systemctl enable "$SERVICE"
if ! systemctl restart "$SERVICE"; then
  echo "Batam service could not start; see journalctl -u $SERVICE" >&2
  if [[ -n $PREVIOUS ]]; then
    ln -sfn "$PREVIOUS" "$APP_DIR/current.new"
    mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
    systemctl restart "$SERVICE" || true
  fi
  exit 1
fi

HEALTHY=0
for _ in $(seq 1 20); do
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then HEALTHY=1; break; fi
  sleep 2
done
if (( HEALTHY == 0 )); then
  echo "Batam failed health check; see journalctl -u $SERVICE" >&2
  if [[ -n $PREVIOUS ]]; then
    ln -sfn "$PREVIOUS" "$APP_DIR/current.new"
    mv -Tf "$APP_DIR/current.new" "$APP_DIR/current"
    systemctl restart "$SERVICE"
    echo "Restored previous release" >&2
  fi
  exit 1
fi

systemctl reload nginx
echo "Batam service healthy at http://127.0.0.1:$PORT/api/health"
echo "Nginx site configured for $DOMAIN"
echo "Run certbot --nginx --redirect -d $DOMAIN after DNS points to this host."
