#!/bin/bash
# Keep a localhost-only FreeLLMAPI running in a Claude Code cloud session.
#
#   freellmapi-start.sh          SessionStart: install/build when needed, then
#                                ensure the server is up and the unified key
#                                is readable.
#   freellmapi-start.sh --check  UserPromptSubmit: fast health check; restarts
#                                a dead server, never installs or builds.
#   freellmapi-start.sh --stop   Stop the server this script manages.
#
# Cloud VMs can be restarted between turns (processes die, the disk stays),
# so --check runs before every prompt to bring the server back.
#
# Inputs come from the cloud environment's variables, never from files in git:
#   ENCRYPTION_KEY        required, 64 hex chars; encrypts provider keys at rest
#   FREEAPI_CONFIG_JSON   optional; declarative admin account + provider keys,
#                         re-applied on every boot (see docs/en/install/01-install.md)
#   FREEAPI_DB_BACKUP_URL optional; encrypted DB backup/restore so the database
#   FREEAPI_DB_BACKUP_TOKEN  (and with it the unified API key) survives sessions
#   FREELLMAPI_PORT       optional, default 3001
#   FREELLMAPI_DATA_DIR, FREELLMAPI_SECRETS_DIR  optional overrides (tests)
#
# Nothing here prints a secret or writes to stdout. Claude Code's own API
# endpoint is left alone.
set -euo pipefail
umask 077

MODE=start
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --stop) MODE=stop ;;
  *) echo "usage: $0 [--check|--stop]" >&2; exit 64 ;;
esac

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

PORT="${FREELLMAPI_PORT:-3001}"
BASE_URL="http://127.0.0.1:${PORT}"
DATA_DIR="${FREELLMAPI_DATA_DIR:-server/data}"
SECRETS_DIR="${FREELLMAPI_SECRETS_DIR:-${HOME}/.config/freellmapi-hub}"
mkdir -p "$DATA_DIR" "$SECRETS_DIR"
chmod 700 "$DATA_DIR" "$SECRETS_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"
LOG="${DATA_DIR}/server.log"
PID_FILE="${DATA_DIR}/server.pid"
KEY_FILE="${SECRETS_DIR}/unified-key"
# One-time setup and password-reset codes are credentials; keep them off disk.
REDACT='s/((setup|reset) code:[[:space:]]*)[^[:space:]]+/\1<redacted>/I'

say() { echo "[freellmapi] $*" >&2; }
fail() { say "ERROR: $*"; exit 1; }
ping_ok() { curl -fsS --noproxy '*' -m 2 -o /dev/null "${BASE_URL}/api/ping" 2>/dev/null; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; }
show_log_tail() { tail -n 25 "$LOG" 2>/dev/null | sed -E "$REDACT" | grep -v 'NO_PROXY' >&2 || true; }

# The node processes this script started for DATA_DIR, found through a marker
# in their environment. A recycled PID in server.pid can't match this.
managed_pids() {
  local p
  for p in /proc/[0-9]*; do
    [ "$(cat "$p/comm" 2>/dev/null)" = node ] || continue
    grep -qzxF "FREELLMAPI_MANAGED_DIR=${DATA_DIR}" "$p/environ" 2>/dev/null || continue
    echo "${p#/proc/}"
  done
}

stop_managed() {
  local pids
  pids="$(managed_pids)"
  [ -n "$pids" ] || { rm -f "$PID_FILE"; return 0; }
  say "stopping managed server (pid $(echo $pids))"
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 30); do
    [ -z "$(managed_pids)" ] && { rm -f "$PID_FILE"; return 0; }
    sleep 0.5
  done
  say "server ignored SIGTERM for 15s; sending SIGKILL"
  kill -KILL $(managed_pids) 2>/dev/null || true
  sleep 0.5
  [ -z "$(managed_pids)" ] || fail "could not stop the managed server"
  rm -f "$PID_FILE"
}

# Only called while no managed server is writing to the log.
redact_log() {
  [ -f "$LOG" ] || return 0
  if grep -qiE '(setup|reset) code:[[:space:]]*[^[:space:]<]' "$LOG"; then
    sed -i -E "$REDACT" "$LOG"
    say "redacted one-time codes already in ${LOG}"
  fi
  chmod 600 "$LOG"
}

start_server() {
  [ -f server/dist/index.js ] && [ -f client/dist/index.html ] \
    || fail "server is not built; start a new session or run $0 without --check"
  redact_log
  echo "----- $(date -u +%FT%TZ) start (${MODE}) -----" >> "$LOG"
  chmod 600 "$LOG"
  # HOST/PORT are forced so neither a stray .env nor an inherited variable can
  # widen the bind. Output passes through the redaction filter on its way to
  # the log. setsid detaches it from the hook so it outlives the hook; 9>&-
  # keeps it from inheriting (and forever holding) the run lock.
  FREELLMAPI_MANAGED_DIR="$DATA_DIR" HOST=127.0.0.1 PORT="$PORT" NODE_ENV=production \
    FREEAPI_DB_PATH="${FREEAPI_DB_PATH:-${DATA_DIR}/freeapi.db}" \
    setsid nohup bash -c 'node server/dist/index.js 2>&1 | sed -u -E "$1" >> "$2"' \
      freellmapi "$REDACT" "$LOG" < /dev/null > /dev/null 2>&1 9>&- &
  local pid=""
  for _ in $(seq 1 20); do
    pid="$(managed_pids | head -n 1)"
    [ -n "$pid" ] && break
    sleep 0.25
  done
  [ -n "$pid" ] || { show_log_tail; fail "server process did not start; see ${LOG}"; }
  echo "$pid" > "$PID_FILE"
}

# 0 = answering, 1 = still running but not answering, 2 = process gone
wait_ready() {
  for _ in $(seq 1 "$1"); do
    ping_ok && return 0
    [ -n "$(managed_pids)" ] || return 2
    sleep 1
  done
  ping_ok
}

ensure_running() {
  local pids rc
  pids="$(managed_pids)"
  if ping_ok; then
    if [ -n "$pids" ]; then
      echo "$pids" | head -n 1 > "$PID_FILE"
      [ "$MODE" = check ] || say "already running at ${BASE_URL} (pid $(echo $pids))"
    else
      say "reusing a FreeLLMAPI on ${BASE_URL} that this script did not start"
    fi
    return 0
  fi

  if [ -n "$pids" ]; then
    say "managed server (pid $(echo $pids)) is not answering; waiting up to 30s"
    rc=0; wait_ready 30 || rc=$?
    [ "$rc" = 0 ] && { say "ready at ${BASE_URL}"; return 0; }
    [ "$rc" = 1 ] && { say "still not answering; restarting it"; stop_managed; }
  elif port_open; then
    fail "port ${PORT} is held by a process that is not this script's FreeLLMAPI and does not answer /api/ping. Stop it or set FREELLMAPI_PORT."
  fi

  if [ -f "$PID_FILE" ]; then
    say "ignoring stale ${PID_FILE} (pid $(cat "$PID_FILE") is not this script's server)"
    rm -f "$PID_FILE"
  fi
  if [ "$MODE" = start ] && [ -z "${FREEAPI_DB_BACKUP_URL:-}${FREEAPI_DB_BACKUP_TARGET:-}${FREEAPI_DB_BACKUP_PATH:-}" ]; then
    say "WARNING: no FREEAPI_DB_BACKUP_URL; the database and unified key last only as long as this container"
  fi
  say "starting on ${BASE_URL}"
  start_server
  rc=0; wait_ready 60 || rc=$?
  case "$rc" in
    0) say "ready at ${BASE_URL}" ;;
    2) show_log_tail; fail "server exited during startup; see ${LOG}" ;;
    *) show_log_tail; fail "server (pid $(cat "$PID_FILE")) is running but did not answer ${BASE_URL}/api/ping within 60s" ;;
  esac
}

# Refuse to continue if anything widened the bind beyond loopback.
check_bind() {
  local hex files=() bad
  hex="$(printf '%04X' "$PORT")"
  for f in /proc/net/tcp /proc/net/tcp6; do [ -r "$f" ] && files+=("$f"); done
  [ "${#files[@]}" -gt 0 ] || return 0
  bad="$(awk -v p=":${hex}" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p \
    && $2 !~ /^0100007F:/ && $2 !~ /^00000000000000000000000001000000:/ { print $2 }' "${files[@]}")"
  [ -z "$bad" ] || fail "port ${PORT} is listening on a non-loopback address"
}

# Read the unified key into a 0600 file with the admin from FREEAPI_CONFIG_JSON.
# Errors name what went wrong but never echo the JSON or a credential.
fetch_key() {
  rm -f "$KEY_FILE"
  node --input-type=module -e '
    const fail = (msg) => { console.error("[freellmapi] WARNING: " + msg); process.exit(1); };
    let cfg;
    try { cfg = JSON.parse(process.env.FREEAPI_CONFIG_JSON); }
    catch { fail("FREEAPI_CONFIG_JSON is not valid JSON (contents not shown)"); }
    const admin = cfg && typeof cfg === "object" ? cfg.admin : undefined;
    if (!admin || typeof admin.email !== "string" || typeof admin.password !== "string") {
      fail("FREEAPI_CONFIG_JSON has no admin email and password; cannot read the unified key");
    }
    const [base, out] = process.argv.slice(1);
    try {
      const login = await fetch(base + "/api/auth/login", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: admin.email, password: admin.password }) });
      if (!login.ok) fail("dashboard login returned HTTP " + login.status);
      const { token } = await login.json();
      const res = await fetch(base + "/api/settings/api-key", { headers: { authorization: "Bearer " + token } });
      if (!res.ok) fail("reading the unified key returned HTTP " + res.status);
      const { apiKey } = await res.json();
      if (typeof apiKey !== "string" || !apiKey) fail("the server returned no unified key");
      (await import("node:fs")).writeFileSync(out, apiKey + "\n", { mode: 0o600 });
    } catch (err) {
      fail("could not read the unified key from " + base + " (" + (err && err.name) + ")");
    }
  ' "$BASE_URL" "$KEY_FILE" || return 1
  chmod 600 "$KEY_FILE"
}

models_status() {
  curl -sS --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$KEY_FILE")") "${BASE_URL}/v1/models" 2>/dev/null || true
}

# Prove the API answers this process tree, authenticated when we can.
ensure_key() {
  if [ -z "${FREEAPI_CONFIG_JSON:-}" ]; then
    [ "$MODE" = check ] || say "no FREEAPI_CONFIG_JSON; add an admin and provider keys there to configure this server"
    return 0
  fi
  if [ "$MODE" = check ] && [ -s "$KEY_FILE" ] && [ "$(models_status)" = 200 ]; then
    return 0
  fi
  fetch_key || return 0
  local code
  code="$(models_status)"
  [ "$code" = 200 ] || fail "GET /v1/models with the unified key returned HTTP ${code:-none}"
  [ "$MODE" = check ] || say "unified key written to ${KEY_FILE}; GET /v1/models: 200"
}

# Non-secret pointers for later tools, each written once. Deliberately no
# ANTHROPIC_* variables: Claude Code keeps its normal endpoint.
add_env() {
  [ -n "${CLAUDE_ENV_FILE:-}" ] || return 0
  grep -qxF "$1" "$CLAUDE_ENV_FILE" 2>/dev/null || echo "$1" >> "$CLAUDE_ENV_FILE"
}

# Serialize runs: SessionStart and UserPromptSubmit can overlap.
exec 9>> "${DATA_DIR}/.hook.lock"
flock -w 180 9 || fail "another run of this script still holds ${DATA_DIR}/.hook.lock after 180s"

if [ "$MODE" = stop ]; then
  stop_managed
  exit 0
fi

case "${ENCRYPTION_KEY:-}" in
  "") fail "ENCRYPTION_KEY is not set. Add it as an environment variable in the cloud environment settings." ;;
esac
[[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || fail "ENCRYPTION_KEY must be exactly 64 hex characters."

[ -f "$PID_FILE" ] && chmod 600 "$PID_FILE"
[ -f "$LOG" ] && chmod 600 "$LOG"

if [ "$MODE" = start ]; then
  # Install and build only when inputs changed, and never under a running
  # server: npm ci deletes node_modules and the build rewrites dist/.
  hashes=node_modules/.session-start.sha256
  manifests=(package.json package-lock.json shared/package.json server/package.json client/package.json cli/package.json)
  need_install=0
  sha256sum --check --status "$hashes" 2>/dev/null || need_install=1
  stamp=server/dist/.build-stamp
  want="$( { git ls-files -s shared server client cli package-lock.json; git diff HEAD -- shared server client cli; } | sha256sum | cut -d' ' -f1)"
  need_build=0
  if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ] || [ ! -f server/dist/index.js ] || [ ! -f client/dist/index.html ]; then
    need_build=1
  fi
  if [ "$need_install" = 1 ] || [ "$need_build" = 1 ]; then
    stop_managed
  fi
  if [ "$need_install" = 1 ]; then
    rm -f "$hashes"
    say "installing dependencies (npm ci)"
    npm ci --no-audit --no-fund >&2
    sha256sum "${manifests[@]}" > "$hashes"
  fi
  if [ "$need_build" = 1 ]; then
    say "building server, cli and dashboard"
    npm run build >&2
    echo "$want" > "$stamp"
  fi
else
  [ -d node_modules ] || fail "dependencies are not installed; start a new session or run $0 without --check"
fi

ensure_running
check_bind
ensure_key
add_env "export FREELLMAPI_URL=${BASE_URL}"
add_env "export FREELLMAPI_KEY_FILE=${KEY_FILE}"
