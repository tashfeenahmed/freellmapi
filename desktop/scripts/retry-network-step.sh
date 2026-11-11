#!/usr/bin/env bash
# Retry only transient download failures, keeping the current build/cache.
# Real compiler, configuration, integrity and test failures must stay failures.
set -uo pipefail

attempts=${CI_NETWORK_RETRY_ATTEMPTS:-3}
delay=${CI_NETWORK_RETRY_DELAY_SECONDS:-10}
if [[ ! $attempts =~ ^[1-5]$ || ! $delay =~ ^[0-9]{1,2}$ ]] || (( $# == 0 )); then
  printf '%s\n' 'Usage: retry-network-step.sh <command> [args...]; attempts 1–5, delay 0–60 seconds' >&2
  exit 2
fi
delay=$(( 10#$delay ))
if (( delay > 60 )); then
  printf '%s\n' 'Retry delay must be 0–60 seconds' >&2
  exit 2
fi

network_log=$(mktemp)
trap 'rm -f -- "$network_log"' EXIT
network_error='HTTP(Error)?[^[:cntrl:]]*(408|500|502|503|504)|status( code)?[ :]+(408|500|502|503|504)|Response code[ :]+(408|500|502|503|504)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|Client network socket disconnected'
permanent_error='error TS[0-9]{3,}|SyntaxError:|ERR_ELECTRON_BUILDER_INVALID_CONFIGURATION|npm (ERR!|error) code (ERESOLVE|EJSONPARSE|ETARGET|EINTEGRITY)|gyp ERR! build error|MODULE_NOT_FOUND|Cannot find module|invalid configuration'

for (( attempt=1; attempt<=attempts; attempt++ )); do
  "$@" 2>&1 | tee "$network_log"
  pipeline_status=("${PIPESTATUS[@]}")
  status=${pipeline_status[0]}
  # A failed logger must not turn a failed or unobservable build green.
  if (( pipeline_status[1] != 0 )); then exit "${pipeline_status[1]}"; fi
  if (( status == 0 )); then exit 0; fi
  # Cancellation is never a reason to start another child process.
  if (( status >= 128 )); then exit "$status"; fi
  if grep -Eqi "$permanent_error" "$network_log" || ! grep -Eqi "$network_error" "$network_log"; then
    exit "$status"
  fi
  if (( attempt == attempts )); then exit "$status"; fi
  pause=$(( delay * attempt ))
  printf '::warning::Transient download failure (attempt %s/%s); retrying in %s seconds with build caches preserved\n' "$attempt" "$attempts" "$pause"
  sleep "$pause"
done
