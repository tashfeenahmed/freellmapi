#!/usr/bin/env bash
# setup.sh — FreeLLMAPI (SQLite) first-run setup on the target server.
#
#   1. Check prerequisites (node, npm)
#   2. Install production dependencies
#   3. Create .env from .env.example (auto-generates ENCRYPTION_KEY)
#   4. Print how to start the server
#
# SQLite needs no separate database/user step — migrations run on first boot.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "============================================"
echo "  FreeLLMAPI (SQLite) — First-Run Setup"
echo "============================================"
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────────────
echo "〔1/3〕Checking prerequisites…"

if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install Node.js >= 20.18 first."
  exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >= 20.18 required (found $(node -v))."
  exit 1
fi
echo "  Node.js: $(node -v) ✓"

if ! command -v npm &>/dev/null; then
  echo "Error: npm not found."
  exit 1
fi
echo "  npm: $(npm -v) ✓"
echo ""

# ── 2. Install dependencies ───────────────────────────────────────────────
echo "〔2/3〕Installing production dependencies…"
npm install --omit=dev
echo "  Dependencies installed ✓"
echo ""

# ── 3. Configure .env ─────────────────────────────────────────────────────
echo "〔3/3〕Configuring .env…"

if [ -f .env ]; then
  echo "  .env already exists — using existing config."
else
  if [ ! -f .env.example ]; then
    echo "Error: .env.example not found."
    exit 1
  fi
  cp .env.example .env

  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/your-64-char-hex-key-here/$ENC_KEY/" .env
  else
    sed -i "s/your-64-char-hex-key-here/$ENC_KEY/" .env
  fi
  echo "  .env created from .env.example (ENCRYPTION_KEY auto-generated)."
  echo "  Review PORT, HOST, DASHBOARD_ORIGINS, and FREEAPI_DB_PATH."
fi
echo ""

# ── Done ──────────────────────────────────────────────────────────────────
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Start the server:"
echo "  npm start"
echo ""
echo "Then open http://<server-ip>:\${PORT:-3001} to create the admin account."
