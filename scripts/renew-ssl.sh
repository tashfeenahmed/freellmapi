#!/usr/bin/env bash
# Renew Let's Encrypt certs (outside the 400MB slice), reload llm-nginx.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
need_cmd certbot
require_env_file
ensure_runtime_dirs

certbot renew --webroot -w "$WEBROOT" --quiet || certbot renew --quiet

if systemctl is-active --quiet llm-nginx.service 2>/dev/null; then
  systemctl reload llm-nginx.service
fi

echo "OK renew finished"
