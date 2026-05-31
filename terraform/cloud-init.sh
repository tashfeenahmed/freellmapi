#!/bin/bash
# cloud-init user_data — runs once as root on first boot of the A1 instance.
# Installs Docker, then runs the FreeLLMAPI container (pulled from GHCR) plus
# Watchtower, which auto-redeploys when CI pushes a new image. No SSH-based
# deploy step: shipping = CI building a new image.
#
# Terraform renders this with templatefile(): a dollar-brace token is a
# Terraform variable; double the dollar to emit a literal shell variable.
# No `-x`: tracing would echo the ENCRYPTION_KEY and GHCR token into the log.
set -euo pipefail
exec > >(tee -a /var/log/freellmapi-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

# --- Docker engine (official convenience script, supports arm64/Ubuntu) -------
apt-get update -y
apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

APP_DIR=/opt/freellmapi
mkdir -p "$APP_DIR"

# --- GHCR auth (only if the package is private) -------------------------------
# Ensure the docker config exists so Watchtower's read-only bind mount has a
# file to mount even when the image is public (no login performed).
mkdir -p /root/.docker
[ -f /root/.docker/config.json ] || echo '{}' > /root/.docker/config.json
if [ -n "${ghcr_pull_token}" ]; then
  echo "${ghcr_pull_token}" | docker login ghcr.io -u "${ghcr_username}" --password-stdin
fi

# --- App environment ----------------------------------------------------------
cat > "$APP_DIR/.env" <<ENV
ENCRYPTION_KEY=${encryption_key}
PORT=3001
HOST_BIND=0.0.0.0
PROXY_RATE_LIMIT_RPM=${proxy_rate_limit_rpm}
ENV
chmod 600 "$APP_DIR/.env"

# --- Compose stack: app + Watchtower auto-updater -----------------------------
# HOST_BIND=0.0.0.0 publishes 3001 on the instance so the load balancer backend
# can reach it; nsg-app still restricts 3001 to the LB only.
cat > "$APP_DIR/docker-compose.yml" <<COMPOSE
services:
  freellmapi:
    image: ${app_image}
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3001
    ports:
      - "0.0.0.0:3001:3001"
    volumes:
      - freellmapi-data:/app/server/data
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

  watchtower:
    image: containrrr/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker/config.json:/config.json:ro
    command: --cleanup --label-enable --interval 300

volumes:
  freellmapi-data:
COMPOSE

cd "$APP_DIR"
docker compose pull
docker compose up -d

echo "freellmapi cloud-init complete"
