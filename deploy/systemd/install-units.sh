#!/usr/bin/env bash
# Render systemd units from templates and install them (root required).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../scripts/lib.sh
source "${SCRIPT_DIR}/../../scripts/lib.sh"

require_root
require_env_file

DEST="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
OUT="${LLMAP_ROOT}/deploy/runtime/systemd"

render_systemd_units
render_nginx

for unit in llm.nalits.slice llmapi.service llm-nginx.service; do
  [ -f "${OUT}/${unit}" ] || die "missing rendered unit: ${OUT}/${unit}"
  install -m 0644 "${OUT}/${unit}" "${DEST}/${unit}"
  echo "Installed ${DEST}/${unit}"
done

systemctl daemon-reload
systemctl enable llm.nalits.slice llmapi.service llm-nginx.service
echo "Enabled. Next: sudo ./scripts/start-stack.sh"
