#!/usr/bin/env bash
# Start stack: ensure TLS (ACME on :80 if needed), then llmapi + nginx (≤400MB).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
need_cmd systemctl
need_cmd nginx
need_cmd node
need_cmd certbot

require_units_installed
require_env_file
require_built
require_ssl_email

# 1) Certs first (temporary :80 ACME nginx outside the memory slice if missing)
ensure_tls_certs

# 2) Production configs + capped services
render_nginx
nginx -t -c "$NGINX_CONF" || die "nginx -t failed"

systemctl start llmapi.service
assert_unit_in_slice llmapi.service
wait_for_port 3001 || die "llmapi did not listen on 127.0.0.1:3001"

systemctl start llm-nginx.service
assert_unit_in_slice llm-nginx.service
assert_slice_memory_max

echo "OK https://${DOMAIN}  (slice ${SLICE_NAME}, MemoryMax=400M)"
