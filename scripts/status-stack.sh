#!/usr/bin/env bash
# Status: units, slice memory, TLS, listeners.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

need_cmd systemctl

printf 'units\n'
for unit in llmapi.service llm-nginx.service "$SLICE_NAME"; do
  printf '  %-18s  %-10s  slice=%s  pid=%s\n' \
    "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null || echo unknown)" \
    "$(unit_prop "$unit" Slice)" \
    "$(unit_prop "$unit" MainPID)"
done

printf '\nmemory (%s)\n' "$SLICE_NAME"
if [ -f "${SLICE_CGROUP}/memory.current" ]; then
  cur="$(cat "${SLICE_CGROUP}/memory.current")"
  max="$(cat "${SLICE_CGROUP}/memory.max")"
  swap="$(cat "${SLICE_CGROUP}/memory.swap.current" 2>/dev/null || echo 0)"
  printf '  current  %s (%s)\n' "$cur" "$(format_bytes "$cur")"
  printf '  max      %s (%s)\n' "$max" "$(format_bytes "$max")"
  printf '  swap     %s (%s)\n' "$swap" "$(format_bytes "$swap")"
  if [ "$max" = "419430400" ] || [ "$max" = "$MEMORY_MAX_BYTES" ]; then
    printf '  cap      OK (400M)\n'
  else
    printf '  cap      UNEXPECTED\n' >&2
  fi
else
  printf '  inactive (MemoryMax=%s)\n' "$(unit_prop "$SLICE_NAME" MemoryMax)"
fi

printf '\ntls\n'
if [ -n "${DOMAIN:-}" ] && [ -f "$CERT_FULLCHAIN" ]; then
  printf '  domain   %s\n' "$DOMAIN"
  if command -v openssl >/dev/null 2>&1; then
    openssl x509 -in "$CERT_FULLCHAIN" -noout -dates -subject 2>/dev/null | sed 's/^/  /'
  else
    printf '  %s\n' "$CERT_FULLCHAIN"
  fi
else
  printf '  missing — start-stack will issue via ACME on :80\n'
fi

printf '\nlisten\n'
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep -E ':80 |:443 |:3001 ' | sed 's/^/  /' || printf '  (none)\n'
else
  printf '  (ss unavailable)\n'
fi
