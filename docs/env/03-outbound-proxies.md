# Outbound proxies

How FreeLLMAPI routes its provider-bound traffic through proxies, which variables win when several are set, and the Docker networking gotchas that come with that.

Sources: [`.env.example`](../../.env.example) (proxy block), [`docker-compose.yml`](../../docker-compose.yml), and the container-networking notes in [`docs/install.md`](../install.md).

- [Proxy chain precedence](#proxy-chain-precedence)
- [Scheme support](#scheme-support)
- [NO_PROXY bypasses](#no_proxy-bypasses)
- [Docker: 127.0.0.1 is the container](#docker-127001-is-the-container)
- [Related inbound rate-limit knobs](#related-inbound-rate-limit-knobs)

## Proxy chain precedence

Outbound proxy for provider requests is normally set in the dashboard (Keys → Outbound proxy); the env vars exist for headless installs. When several sources are present, resolution order is:

```
PROXY_URL → dashboard setting → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY
```

The standard variables are also read in their lower-case spellings (`all_proxy`, `https_proxy`, `http_proxy`).

| Variable | Role in the chain |
| --- | --- |
| `PROXY_URL` | Explicit FreeLLMAPI proxy setting; highest precedence. |
| Dashboard setting | Keys → Outbound proxy; beats the generic environment variables. |
| `ALL_PROXY` | Standard catch-all proxy variable. |
| `HTTPS_PROXY` / `HTTP_PROXY` | Conventional per-scheme variables, lowest precedence. |

## Scheme support

Accepted schemes: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.

The `h`/`a` variants (`socks5h`, `socks4a`) resolve DNS at the proxy rather than locally, which is what you want on a DNS-poisoned network. Example:

```env
PROXY_URL=socks5h://127.0.0.1:1080
```

## NO_PROXY bypasses

`NO_PROXY` lists hosts that must be reached directly, bypassing whichever proxy won above:

```env
NO_PROXY=localhost,127.0.0.1,.internal.corp
```

- Comma-separated entries.
- A bare domain also covers its subdomains.
- The special value `*` disables the proxy entirely.

## Docker: 127.0.0.1 is the container

Inside a container, `127.0.0.1` is the container itself — not your machine (#733). If your proxy client runs on the host (Clash, v2rayN, sing-box, a corporate proxy), two adjustments are needed:

1. Point FreeLLMAPI at the host's address instead of loopback:

   ```env
   PROXY_URL=socks5h://host.docker.internal:7890
   ```

2. Make sure the proxy listens on more than loopback (in Clash: `allow-lan: true`).

The bundled `docker-compose.yml` maps `host.docker.internal` to the host gateway via an `extra_hosts` entry, so this works on plain Linux Docker too, not just Docker Desktop (which provides the name already):

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

A second, unrelated way a container can be cut off from providers while the host works fine: on an IPv6-only host, the default bridge network is IPv4-only, so the container cannot reach anything — DNS included. Enable IPv6 in `/etc/docker/daemon.json` (`"ipv6": true`, `"ip6tables": true`, a `"fixed-cidr-v6"` range) and restart Docker.

To see which case you are hitting, ask the container directly:

```bash
docker compose exec freellmapi node -e "fetch('https://generativelanguage.googleapis.com/').then(r=>console.log('ok',r.status)).catch(e=>console.log('fail',e.cause?.code||e.message))"
```

## Related inbound rate-limit knobs

Despite the shared "proxy" name, these two variables throttle *inbound* traffic to FreeLLMAPI itself, not outbound provider calls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_RATE_LIMIT_RPM` | `120` | Max `/v1` proxy requests per minute per client IP. `0` disables. |
| `ADMIN_RATE_LIMIT_RPM` | `600` | Max `/api` dashboard requests per minute per client IP — a flood guard; login has its own per-email lockout and key export its own much tighter cap. `0` disables. |

Full descriptions live in [01-variables.md](01-variables.md#rate-limits).
