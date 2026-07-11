#!/usr/bin/env bash
# Shared helpers for the native stack scripts.
# shellcheck shell=bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LLMAP_ROOT="${LLMAP_ROOT:-$ROOT}"

ENV_FILE="${LLMAP_ROOT}/deploy/.env"
RUNTIME_NGINX="${LLMAP_ROOT}/deploy/runtime/nginx"
# Outside /home so nginx workers (www-data) can read challenge files (avoids 403).
WEBROOT="${ACME_WEBROOT:-/var/www/llmapi-acme}"
NGINX_CONF="${RUNTIME_NGINX}/nginx.conf"
ACME_NGINX_CONF="${RUNTIME_NGINX}/nginx.acme.conf"
SLICE_NAME="llm.nalits.slice"
SLICE_CGROUP="/sys/fs/cgroup/${SLICE_NAME}"
MEMORY_MAX_BYTES=$((400 * 1024 * 1024))

# Load deploy/.env if present (DOMAIN and secrets).
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DOMAIN="${DOMAIN:-${LLM_DOMAIN:-}}"
CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/${DOMAIN}}"
CERT_FULLCHAIN="${CERT_DIR}/fullchain.pem"
CERT_PRIVKEY="${CERT_DIR}/privkey.pem"

die() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
}

require_domain() {
  [ -n "$DOMAIN" ] ||
    die "DOMAIN is unset — set DOMAIN in deploy/.env"
}

ensure_runtime_dirs() {
  mkdir -p \
    "${RUNTIME_NGINX}/sites" \
    "${WEBROOT}/.well-known/acme-challenge"
  # www-data must traverse and read challenge files for HTTP-01.
  chmod 755 "${WEBROOT}" "${WEBROOT}/.well-known" "${WEBROOT}/.well-known/acme-challenge" 2>/dev/null || true
}

# Substitute placeholders into a template.
render_template() {
  local src="$1" dest="$2"
  [ -f "$src" ] || die "missing template: $src"
  require_domain
  awk -v root="$LLMAP_ROOT" -v domain="$DOMAIN" -v webroot="$WEBROOT" '
    {
      gsub(/__LLMAP_ROOT__/, root)
      gsub(/__DOMAIN__/, domain)
      gsub(/__ACME_WEBROOT__/, webroot)
      print
    }
  ' "$src" > "$dest"
}

render_nginx() {
  ensure_runtime_dirs
  render_template \
    "${LLMAP_ROOT}/deploy/nginx/templates/nginx.conf.template" \
    "$NGINX_CONF"
  render_template \
    "${LLMAP_ROOT}/deploy/nginx/templates/nginx.acme.conf.template" \
    "$ACME_NGINX_CONF"
  render_template \
    "${LLMAP_ROOT}/deploy/nginx/templates/site.conf.template" \
    "${RUNTIME_NGINX}/sites/site.conf"
}

render_systemd_units() {
  local out="${LLMAP_ROOT}/deploy/runtime/systemd"
  mkdir -p "$out"
  render_template \
    "${LLMAP_ROOT}/deploy/systemd/llm.nalits.slice.template" \
    "${out}/llm.nalits.slice"
  render_template \
    "${LLMAP_ROOT}/deploy/systemd/llmapi.service.template" \
    "${out}/llmapi.service"
  render_template \
    "${LLMAP_ROOT}/deploy/systemd/llm-nginx.service.template" \
    "${out}/llm-nginx.service"
}

require_built() {
  [ -f "${LLMAP_ROOT}/server/dist/index.js" ] ||
    die "missing server/dist — run: npm ci && npm run build"
}

certs_present() {
  require_domain
  [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_PRIVKEY" ]
}

require_certs() {
  certs_present ||
    die "TLS missing for ${DOMAIN}"
}

require_ssl_email() {
  [ -n "${SSL_EMAIL:-}" ] ||
    die "SSL_EMAIL is unset — set it in deploy/.env (Let's Encrypt registration)"
}

# Temporary ACME nginx on :80 + certbot (outside llm.nalits.slice).
# Used by start-stack when certs are missing, and by issue-ssl.sh.
issue_certs_via_acme() {
  need_cmd certbot
  need_cmd nginx
  require_domain
  require_ssl_email

  if systemctl is-active --quiet llm-nginx.service 2>/dev/null; then
    die "llm-nginx.service is running — stop it before ACME bootstrap on :80"
  fi

  render_nginx

  local acme_pid_file="${RUNTIME_NGINX}/acme-nginx.pid"
  cleanup_acme() {
    if [ -f "$acme_pid_file" ]; then
      local pid
      pid="$(cat "$acme_pid_file" 2>/dev/null || true)"
      if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill -QUIT "$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
        sleep 0.3
      fi
      rm -f "$acme_pid_file"
    fi
    nginx -c "$ACME_NGINX_CONF" -s quit 2>/dev/null || true
  }
  # Clear a leftover ACME master from a previous failed run.
  cleanup_acme
  trap cleanup_acme RETURN

  echo "ACME: starting temporary nginx on :80 for ${DOMAIN} (webroot ${WEBROOT})..."
  nginx -t -c "$ACME_NGINX_CONF"
  nginx -c "$ACME_NGINX_CONF"

  echo "ACME: requesting certificate (certbot, outside ${SLICE_NAME})..."
  certbot certonly \
    --webroot \
    -w "$WEBROOT" \
    -d "$DOMAIN" \
    --email "$SSL_EMAIL" \
    --agree-tos \
    --non-interactive \
    --keep-until-expiring

  cleanup_acme
  trap - RETURN
  require_certs
  echo "ACME: OK ${CERT_DIR}"
}

# Ensure TLS exists; issue via :80 ACME bootstrap if missing.
ensure_tls_certs() {
  if certs_present; then
    echo "TLS: using existing certs for ${DOMAIN}"
    return 0
  fi
  echo "TLS: no certs for ${DOMAIN} — issuing via ACME on :80"
  issue_certs_via_acme
}

require_env_file() {
  [ -f "$ENV_FILE" ] ||
    die "missing deploy/.env — copy deploy/.env.example and set ENCRYPTION_KEY, DOMAIN, SSL_EMAIL"
  grep -qE '^ENCRYPTION_KEY=[0-9a-fA-F]{64}$' "$ENV_FILE" ||
    die "deploy/.env: ENCRYPTION_KEY must be 64 hex chars"
  require_domain
}

require_units_installed() {
  [ -f /etc/systemd/system/llm.nalits.slice ] &&
    [ -f /etc/systemd/system/llmapi.service ] &&
    [ -f /etc/systemd/system/llm-nginx.service ] ||
    die "units not installed — run: sudo ./deploy/systemd/install-units.sh"
}

unit_prop() {
  systemctl show -p "$2" --value "$1" 2>/dev/null || true
}

assert_unit_in_slice() {
  local slice
  slice="$(unit_prop "$1" Slice)"
  [ "$slice" = "$SLICE_NAME" ] ||
    die "$1 Slice='${slice}' (expected ${SLICE_NAME})"
}

assert_slice_memory_max() {
  local raw
  if [ -f "${SLICE_CGROUP}/memory.max" ]; then
    raw="$(cat "${SLICE_CGROUP}/memory.max")"
  else
    raw="$(unit_prop "$SLICE_NAME" MemoryMax)"
  fi
  case "$raw" in
    419430400 | 400M | 400m | "$MEMORY_MAX_BYTES") return 0 ;;
    '' | infinity | Infinity | max)
      die "${SLICE_NAME} MemoryMax unset (${raw:-empty})"
      ;;
    *)
      die "${SLICE_NAME} MemoryMax='${raw}' (expected 400M)"
      ;;
  esac
}

format_bytes() {
  local b="$1"
  [[ "$b" =~ ^[0-9]+$ ]] || { printf '%s' "$b"; return; }
  awk -v b="$b" 'BEGIN { printf "%.1fMiB", b/1024/1024 }'
}

wait_for_port() {
  local port="$1" i
  for i in $(seq 1 50); do
    if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}
