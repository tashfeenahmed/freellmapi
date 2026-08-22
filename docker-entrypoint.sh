#!/bin/sh
set -e

# PaaS runtimes (Railway, Render, ...) bind-mount the persistent volume at
# /app/server/data with root ownership, while the image runs as USER node.
# Chown the data dir before starting so better-sqlite3 can create the DB
# there, then drop back to the unprivileged user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/server/data
  chown -R node:node /app/server/data
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u node -- "$@"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
