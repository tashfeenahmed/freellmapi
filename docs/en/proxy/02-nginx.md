# Running behind nginx

[← Proxy overview](OVERVIEW.md) · [Environment variables](../env/01-variables.md)

FreeLLMAPI grants a few shortcuts to requests from "this machine":

- first-run setup without the one-time setup code;
- Ollama `open-loopback` inference without a key;
- on desktop installs, browser sign-in and key reveal/export without a password.

A reverse proxy on the same host connects from `127.0.0.1` for every client on
the internet. If the server mistakes the proxy for a local user, a stranger can
claim an unclaimed dashboard or use your inference without a key. The rules
the server applies are in `server/src/lib/request-locality.ts`, and they are
tested against a real nginx in
`server/src/__tests__/integration/nginx-proxy.test.ts`.

## Production setup (recommended)

Environment:

```bash
NODE_ENV=production
ENCRYPTION_KEY=<64 hex chars>
HOST=127.0.0.1            # reachable only through nginx
PORT=3001
TRUST_PROXY=1             # exactly one proxy (this nginx) in front
DISABLE_LOCAL_TRUST=true  # nothing is "local" behind a proxy
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name llm.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        # Overwrite, never append: whatever the client sent is discarded.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming responses (SSE) must not be buffered.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

With `DISABLE_LOCAL_TRUST=true`:

- create the first account with the setup code printed in the server log, or
  create it before you expose the proxy;
- use Ollama emulation in `key-required` mode;
- desktop shortcuts are off. The desktop app's own window keeps working,
  because it signs in over IPC rather than HTTP.

Analytics and the per-IP rate limits see the real client through
`TRUST_PROXY=1`.

## What the server does if nginx is configured wrongly

Without `DISABLE_LOCAL_TRUST`, the server still refuses locality whenever it can
tell a proxy is involved:

| nginx config | Remote client treated as local? |
|---|---|
| `X-Forwarded-For $remote_addr` or `$proxy_add_x_forwarded_for`, `TRUST_PROXY=1` | No. A local browser through the proxy is local. |
| `X-Real-IP $remote_addr` only | No. A client-sent `X-Forwarded-For` that contradicts `X-Real-IP` fails closed. `X-Real-IP` alone never grants locality. |
| Bare `proxy_pass` (nginx defaults) | No. nginx speaks HTTP/1.0 upstream, which is never local. |
| Any header the server cannot verify (`Forwarded`, `CF-Connecting-IP`, …), or a malformed `X-Forwarded-For` | No. |
| `TRUST_PROXY=true` | No proxied request is ever local. |
| **Bare `proxy_pass` with `proxy_http_version 1.1` and no forwarding headers** | **Yes.** The request is identical to a local one. Only `DISABLE_LOCAL_TRUST=true` prevents this. |

That last row is why `DISABLE_LOCAL_TRUST=true` belongs in every proxied
deployment: it makes the server safe whatever the proxy sends. The server logs a
warning at boot when `TRUST_PROXY` is set and `DISABLE_LOCAL_TRUST` is not.

## Don't

- Don't set `TRUST_PROXY=true` on a server reachable from untrusted networks.
- Don't set `TRUST_PROXY` to a hop count larger than the number of proxies you
  actually run, or to an address list containing addresses clients can use.
- Don't publish the app port on a public interface as well as through nginx.

## Verify

From a machine that is not the server, against a fresh install:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://llm.example.com/api/auth/setup \
  -H 'Host: localhost' -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Real-IP: 127.0.0.1' \
  -H 'Content-Type: application/json' -d '{"email":"x"}'
```

Expect `403` (setup code required). A `400` means the request was treated as
local: check the nginx config and `DISABLE_LOCAL_TRUST`. The invalid body means
the command never creates an account.
