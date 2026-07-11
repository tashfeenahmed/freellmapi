# Deploy

Native FreeLLMAPI + dedicated nginx. No Docker. No Podman.

Both processes run in systemd slice `llm.nalits.slice` with a hard combined
limit of **400MB** (`MemoryMax=400M`, `MemorySwapMax=0`).

| Unit | Role |
|------|------|
| `llmapi.service` | Node API on loopback (`HOST`/`PORT` from `deploy/.env`) |
| `llm-nginx.service` | TLS reverse proxy on `:80` / `:443` |

Set `DOMAIN` and `SSL_EMAIL` in `deploy/.env`. Templates are rendered into
`deploy/runtime/` at install/start (no machine-specific paths in source).

## Prerequisites

- Node.js ≥ 20.18, nginx, certbot
- DNS for `DOMAIN` → this host
- Ports 80 and 443 free (disable system `nginx.service` if present)
- Enough free host RAM for the stack

ACME challenge files are served from `/var/www/llmapi-acme` (not under `/home`),
so nginx workers can read them without HTTP 403.

## One-time setup

```bash
cd /path/to/llmapi

npm ci && npm run build

cp deploy/.env.example deploy/.env
# set DOMAIN, SSL_EMAIL, ENCRYPTION_KEY

sudo ./deploy/systemd/install-units.sh
```

## Start

```bash
sudo ./scripts/start-stack.sh
sudo ./scripts/status-stack.sh
```

`start-stack.sh` will:

1. If TLS certs for `DOMAIN` are missing — start a temporary nginx on **:80**, run certbot (outside the 400MB slice), then stop that bootstrap nginx
2. Start `llmapi.service` + `llm-nginx.service` under the 400MB slice (production **:80/:443**)

## Stop

```bash
sudo ./scripts/stop-stack.sh
```

## Renew TLS

```bash
sudo ./scripts/renew-ssl.sh
```

Optional manual re-issue (same ACME path as start): `./scripts/issue-ssl.sh`

## Layout

```
deploy/
  .env.example
  .env                      # local (gitignored)
  nginx/templates/
  systemd/*.template
  runtime/
scripts/
  start-stack.sh
  stop-stack.sh
  status-stack.sh
  issue-ssl.sh
  renew-ssl.sh
  lib.sh
```

## Memory

- **Inside 400MB:** `llmapi.service` + `llm-nginx.service` only
- **Outside:** `npm` build, certbot, temporary ACME nginx during issue
- Over limit → OOM kill inside the slice; peak cannot exceed 400MB
