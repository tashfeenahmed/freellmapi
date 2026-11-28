#!/bin/bash
cd "$(dirname "$0")" || exit 1
node scripts/dev-start.mjs
result=$?
if [ "$result" -ne 0 ]; then read -r -p "Press Enter to close..."; fi
exit "$result"
