#!/usr/bin/env bash
# Stop llmapi + dedicated nginx.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
need_cmd systemctl

systemctl stop llm-nginx.service 2>/dev/null || true
systemctl stop llmapi.service 2>/dev/null || true
echo "OK stack stopped"
