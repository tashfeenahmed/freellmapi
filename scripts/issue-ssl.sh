#!/usr/bin/env bash
# Manually issue/refresh certs via ACME on :80 (same path start-stack uses).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

require_root
require_env_file
require_ssl_email
issue_certs_via_acme
echo "Next: ./scripts/start-stack.sh (if the stack is not already up)"
