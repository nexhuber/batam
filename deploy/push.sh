#!/usr/bin/env bash
# Upload Batam from this machine and run deploy/install.sh on a Linux host.
set -euo pipefail

HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to an SSH target, e.g. user@server}"
DOMAIN="${DEPLOY_DOMAIN:?Set DEPLOY_DOMAIN to Batam's public hostname}"
PORT="${DEPLOY_PORT:-3200}"
ENV_SOURCE="${DEPLOY_ENV_SOURCE:-}"
TLS="${DEPLOY_TLS:-1}"
EMAIL="${CERTBOT_EMAIL:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! $DOMAIN =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]]; then echo "Invalid DEPLOY_DOMAIN" >&2; exit 1; fi
if [[ ! $PORT =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then echo "Invalid DEPLOY_PORT" >&2; exit 1; fi
if [[ -n $ENV_SOURCE && ! $ENV_SOURCE =~ ^/[a-zA-Z0-9_./-]+$ ]]; then echo "Invalid DEPLOY_ENV_SOURCE" >&2; exit 1; fi
if [[ $TLS != 0 && $TLS != 1 ]]; then echo "DEPLOY_TLS must be 0 or 1" >&2; exit 1; fi
if [[ -n $EMAIL && ! $EMAIL =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+$ ]]; then echo "Invalid CERTBOT_EMAIL" >&2; exit 1; fi
for tool in ssh rsync; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done

STAGE="$(ssh "$HOST" 'mktemp -d /tmp/batam-deploy.XXXXXXXX')"
if [[ ! $STAGE =~ ^/tmp/batam-deploy\.[a-zA-Z0-9]+$ ]]; then echo "Invalid remote staging path" >&2; exit 1; fi
cleanup() { ssh "$HOST" "rm -rf '$STAGE'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

rsync -az \
  --exclude='.git' --exclude='.env*' --exclude='node_modules' \
  --exclude='.next' --exclude='*.tsbuildinfo' \
  "$ROOT/" "$HOST:$STAGE/"

ssh -tt "$HOST" "sudo env BATAM_DOMAIN='$DOMAIN' BATAM_PORT='$PORT' BATAM_ENV_SOURCE='$ENV_SOURCE' bash '$STAGE/deploy/install.sh' '$STAGE'"

if [[ $TLS == 1 ]]; then
  if [[ -n $EMAIL ]]; then
    ssh -tt "$HOST" "sudo certbot --nginx --non-interactive --agree-tos --redirect -m '$EMAIL' -d '$DOMAIN'"
  else
    ssh -tt "$HOST" "sudo certbot --nginx --non-interactive --agree-tos --redirect -d '$DOMAIN'"
  fi
  curl --fail --silent --show-error "https://${DOMAIN}/api/health" | grep -q '"status":"ok"'
  echo "HTTPS health check passed: https://${DOMAIN}/api/health"
fi

echo "Deployment complete. Service: batam-dashboard; port: $PORT; domain: $DOMAIN"
