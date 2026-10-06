services:
  freellmapi:
    image: ghcr.io/tashfeenahmed/freellmapi:latest
    build:
      context: .
      dockerfile: Dockerfile
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3001
      # Settings → Check for updates → "Update now". Only active when the
      # `autoupdate` profile below runs and WATCHTOWER_TOKEN is set in .env.
      FREELLMAPI_SELF_UPDATE_URL: http://watchtower:8080
      FREELLMAPI_SELF_UPDATE_TOKEN: ${WATCHTOWER_TOKEN:-}
    labels:
      # The updater below only ever touches containers carrying BOTH labels.
      # The scope keeps it off containers other stacks have opted into their
      # own Watchtower, and keeps theirs off this one.
      com.centurylinklabs.watchtower.enable: "true"
      com.centurylinklabs.watchtower.scope: freellmapi
    # Bound to localhost by default — FreeLLMAPI is single-user and must not be
    # exposed to the internet. Set HOST_BIND=0.0.0.0 to reach it from your LAN.
    ports:
      - "${HOST_BIND:-127.0.0.1}:${PORT:-3001}:3001"
    volumes:
      - freellmapi-data:/app/server/data
    # Makes `host.docker.internal` resolve to the host from inside the
    # container. Docker Desktop provides it already; plain Docker on Linux does
    # not, and without it the documented way to reach a proxy running on the
    # host (PROXY_URL=http://host.docker.internal:7890) fails to resolve.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3001/api/ping').then((res) => { if (!res.ok) process.exit(1); }).catch(() => process.exit(1));"
        ]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3

  # Opt-in self-update: `docker compose --profile autoupdate up -d` with
  # WATCHTOWER_TOKEN set in .env. Watchtower (the maintained nicholas-fedor
  # fork) runs with only its token-protected update endpoint, which the
  # dashboard calls when you click "Update now"; it pulls the newer image and
  # recreates the freellmapi container with the same volume and settings.
  # Nothing happens on a schedule, no port is published, and no other
  # container is touched. It needs the Docker socket, which is root-equivalent
  # on the host — leave the profile off if that is not acceptable.
  watchtower:
    image: nickfedor/watchtower:1.22.3
    profiles: ["autoupdate"]
    environment:
      WATCHTOWER_HTTP_API_ENDPOINTS: update
      WATCHTOWER_HTTP_API_TOKEN: ${WATCHTOWER_TOKEN:-}
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_SCOPE: freellmapi
      WATCHTOWER_CLEANUP: "true"
    labels:
      com.centurylinklabs.watchtower.scope: freellmapi
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped

volumes:
  freellmapi-data:
