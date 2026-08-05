#!/usr/bin/env bash
# dev-bootstrap.sh — bootstrap a FreeLLMAPI contributor checkout on macOS/Linux.
#
# Idempotent one-shot setup mirroring scripts/dev-bootstrap.ps1 so both
# platforms stay in lockstep (issue #434).
#
#   1. Verifies Node meets the engines range (>=20.18.0 <25.0.0).
#   2. Runs `npm install` when node_modules is missing or package-lock.json
#      changed since the last install.
#   3. Creates .env from .env.example with a fresh ENCRYPTION_KEY when .env
#      is missing (never touches an existing .env).
#   4. Prints the next step. It does NOT auto-launch `npm run dev`.
set -euo pipefail

Root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$Root"

log() { echo "[dev-bootstrap] $*"; }

# --- 1. Node version check -----------------------------------------------
node_raw="$(node --version 2>/dev/null || true)"
if [[ ! "$node_raw" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "[dev-bootstrap] Node.js not found on PATH. Install Node 20.18+ (https://nodejs.org) and re-run." >&2
  exit 1
fi
node_ver="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
if [ "$(printf '%s\n' '20.18.0' "$node_ver" | sort -V | head -1)" != '20.18.0' ] ||
   [ "$(printf '%s\n' '25.0.0' "$node_ver" | sort -V | head -1)" != '25.0.0' ]; then
  echo "[dev-bootstrap] Node $node_ver is outside the supported range (>=20.18.0 <25.0.0)." >&2
  exit 1
fi
log "Node $node_ver OK"

# --- 2. npm install when needed ------------------------------------------
need_install=false
if [ ! -d node_modules ]; then
  need_install=true
elif [ -f package-lock.json ] && [ ! -f node_modules/.package-lock.json ]; then
  need_install=true
elif [ -f package-lock.json ] && [ -f node_modules/.package-lock.json ] &&
     [ package-lock.json -nt node_modules/.package-lock.json ]; then
  need_install=true
fi
if [ "$need_install" = true ]; then
  log 'Installing dependencies (npm install)…'
  npm install
else
  log 'node_modules is up to date — skipping npm install'
fi

# --- 3. .env from .env.example -------------------------------------------
if [ ! -f .env ]; then
  [ -f .env.example ] || { echo '[dev-bootstrap] .env.example is missing — is the clone complete?' >&2; exit 1; }
  key="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cp .env.example .env
  if grep -q '^ENCRYPTION_KEY=' .env; then
    # The key is hex, so it cannot contain regex metacharacters.
    sed -i "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$key/" .env
  else
    printf 'ENCRYPTION_KEY=%s\n' "$key" >> .env
  fi
  log 'Created .env with a fresh ENCRYPTION_KEY'
else
  log '.env already exists — leaving it untouched'
fi

# --- 4. Next step ---------------------------------------------------------
echo ''
echo 'Ready. Start the dev servers with:'
echo '    npm run dev'
echo 'Server on :3001, dashboard on :5173 (both with HMR).'
