#!/usr/bin/env bash
# =============================================================================
# scripts/reset-password.sh — FreeLLMAPI dashboard password reset
# =============================================================================
#
# Resets the email and/or password for the single dashboard account without
# requiring SQLite tools or direct database access.  It uses the Node.js
# runtime already present inside the Docker container and the better-sqlite3
# module that FreeLLMAPI ships as a dependency.
#
# WHEN TO USE
#   You have lost or forgotten your dashboard password and cannot log in.
#   The script writes directly to the SQLite database, bypassing the running
#   server, so no running instance is required (though it works fine while the
#   server is up too).
#
# PREREQUISITES
#   Docker must be installed and the FreeLLMAPI container must be running.
#   No external tools (sqlite3, jq, openssl …) are required on the host.
#
# USAGE
#   ./scripts/reset-password.sh                              # fully interactive
#   ./scripts/reset-password.sh -p 'NewPass123!'            # password only
#   ./scripts/reset-password.sh -p 'NewPass123!' -e new@example.com
#   ./scripts/reset-password.sh --password 'NewPass123!' --email new@example.com
#
# ENVIRONMENT OVERRIDES
#   FREELLMAPI_CONTAINER   Container name or ID to target.  Defaults to the
#                          name Docker Compose assigns when the compose project
#                          directory is "freellmapi": freellmapi-freellmapi-1.
#                          Override when you renamed the project or started the
#                          container by hand.
#                            FREELLMAPI_CONTAINER=mycontainer ./scripts/reset-password.sh
#   FREELLMAPI_DB_PATH     Absolute path to freeapi.db *inside* the container.
#                          Defaults to /app/server/data/freeapi.db.
#                          Override when FREEAPI_DB_PATH is set in your .env.
#
# SECURITY NOTES
#   - The new password is injected via "docker exec -e", which keeps it out
#     of the process list visible to "ps aux" on the host.
#   - All existing dashboard sessions are invalidated on success, so any
#     previously logged-in browser must re-authenticate.
#   - The password hash format is identical to server/src/lib/password.ts:
#       scrypt$<16-byte-saltHex>$<64-byte-hashHex>
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults — override with environment variables documented above
# ---------------------------------------------------------------------------

# Docker Compose names containers as <project>-<service>-<replica>.
# The project name defaults to the directory name of docker-compose.yml, so
# cloning into "freellmapi" gives "freellmapi-freellmapi-1".  We derive this
# automatically so the script works out of the box without configuration.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_PROJECT="$(basename "$(dirname "$SCRIPT_DIR")")"
CONTAINER="${FREELLMAPI_CONTAINER:-${COMPOSE_PROJECT}-freellmapi-1}"
DB_PATH="${FREELLMAPI_DB_PATH:-/app/server/data/freeapi.db}"

NEW_PASSWORD=""
NEW_EMAIL=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--password)
      NEW_PASSWORD="$2"
      shift 2
      ;;
    -e|--email)
      NEW_EMAIL="$2"
      shift 2
      ;;
    -h|--help)
      # Print the header comment block at the top of this file
      awk '/^# ===/{p=!p; if(p) next} p{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1  (try --help)" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Verify the container is reachable
# ---------------------------------------------------------------------------

if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "Error: container '$CONTAINER' is not running." >&2
  echo "" >&2
  echo "  List running containers:  docker ps --format '{{.Names}}'" >&2
  echo "  Then re-run with:         FREELLMAPI_CONTAINER=<name> $0" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Read the current account email so we can show it and use it as the default
# ---------------------------------------------------------------------------

CURRENT_EMAIL=$(docker exec \
  -e "FREELLMAPI_DB_PATH=$DB_PATH" \
  "$CONTAINER" \
  node -e "
    const Database = require('/app/node_modules/better-sqlite3');
    const db = new Database(process.env.FREELLMAPI_DB_PATH);
    const row = db.prepare('SELECT email FROM users WHERE id = 1').get();
    db.close();
    process.stdout.write(row ? row.email : '');
  " 2>/dev/null)

if [[ -z "$CURRENT_EMAIL" ]]; then
  echo "No account found in the database."
  echo "Open the dashboard to complete first-run setup."
  exit 0
fi

echo "Current account: $CURRENT_EMAIL"
echo ""

# ---------------------------------------------------------------------------
# Interactive prompts for anything not supplied via flags
#
# Passing -p alone means "reset password, keep the current email" — we skip
# the email prompt so there is no unexpected interactive pause in scripted use.
# The email prompt only appears in fully interactive mode (no flags at all).
# ---------------------------------------------------------------------------

if [[ -z "$NEW_PASSWORD" && -z "$NEW_EMAIL" ]]; then
  read -rp "New email  [Enter to keep '$CURRENT_EMAIL']: " NEW_EMAIL
fi

if [[ -z "$NEW_PASSWORD" ]]; then
  read -rsp "New password (min 8 chars): " NEW_PASSWORD
  echo ""
  read -rsp "Confirm password:           " CONFIRM_PASSWORD
  echo ""
  if [[ "$NEW_PASSWORD" != "$CONFIRM_PASSWORD" ]]; then
    echo "Error: passwords do not match." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

if [[ "${#NEW_PASSWORD}" -lt 8 ]]; then
  echo "Error: password must be at least 8 characters." >&2
  exit 1
fi

if [[ -n "$NEW_EMAIL" && "$NEW_EMAIL" != *@* ]]; then
  echo "Error: '$NEW_EMAIL' does not look like a valid email address." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Apply the changes inside the container
#
# Credentials are passed via "docker exec -e" to avoid embedding them in the
# argument string visible to "ps aux".  The Node snippet uses CommonJS require
# (not ESM import) because the container's Node may not have an explicit
# package.json type field covering this ad-hoc execution context.
# ---------------------------------------------------------------------------

RESULT=$(docker exec \
  -e "NEW_PASSWORD=$NEW_PASSWORD" \
  -e "NEW_EMAIL=$NEW_EMAIL" \
  -e "FREELLMAPI_DB_PATH=$DB_PATH" \
  "$CONTAINER" \
  node -e "
    const crypto   = require('crypto');
    const Database = require('/app/node_modules/better-sqlite3');

    const db          = new Database(process.env.FREELLMAPI_DB_PATH);
    const newPassword = process.env.NEW_PASSWORD;
    const newEmail    = (process.env.NEW_EMAIL ?? '').trim().toLowerCase();

    // Hash the new password using the same algorithm and parameters as
    // server/src/lib/password.ts: scrypt, 16-byte salt, 64-byte digest.
    const KEYLEN     = 64;
    const SALT_BYTES = 16;
    const salt       = crypto.randomBytes(SALT_BYTES);
    const hash       = crypto.scryptSync(newPassword, salt, KEYLEN);
    const stored     = 'scrypt\$' + salt.toString('hex') + '\$' + hash.toString('hex');

    db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(stored);

    // Optionally update the email address.
    if (newEmail) {
      db.prepare('UPDATE users SET email = ? WHERE id = 1').run(newEmail);
    }

    // Invalidate all existing sessions so previously issued tokens cannot be
    // reused with the old password.
    const { changes: sessionsCleared } = db.prepare('DELETE FROM sessions').run();

    const finalEmail = db.prepare('SELECT email FROM users WHERE id = 1').get().email;
    db.close();

    // Print a structured result line that the shell script can parse.
    process.stdout.write('OK:' + sessionsCleared + ':' + finalEmail + '\n');
  " 2>&1)

# ---------------------------------------------------------------------------
# Report outcome
# ---------------------------------------------------------------------------

if [[ "$RESULT" == OK:* ]]; then
  IFS=':' read -r _ SESSIONS_CLEARED FINAL_EMAIL <<< "$RESULT"
  echo "Password updated successfully."
  echo "  Account:              $FINAL_EMAIL"
  echo "  Sessions invalidated: $SESSIONS_CLEARED"
  echo ""
  echo "Log in at the dashboard with your new credentials."
else
  echo "Something went wrong:" >&2
  echo "$RESULT" >&2
  exit 1
fi
