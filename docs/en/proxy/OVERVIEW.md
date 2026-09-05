# Proxy Domain — Overview & File Index

## Scope

This domain documents FreeLLMAPI's outbound proxy transports and the related inbound `TRUST_PROXY` handling. Provider-bound traffic can leave the gateway through two transports:

- **Forward proxy** (`forward` mode, default) — a traditional CONNECT/SOCKS proxy via `PROXY_URL` (explicit `PROXY_URL` → dashboard Keys → Outbound proxy setting → `ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`, with lower-case spellings also read), scheme support `http`/`https`/`socks4`/`socks4a`/`socks5`/`socks5h` (`h`/`a` resolve DNS at the proxy), `NO_PROXY` bypasses, per-key overrides, and the Docker `host.docker.internal` gotcha. When nothing is configured, the chain now falls through to **system auto-detect** (`detectSystemProxy` in `server/src/lib/proxy.ts:52-414` — `scutil --proxy` on macOS, Windows Internet Options registry `ProxyEnable`/`ProxyServer`, GNOME `gsettings` `manual` + `http host/port` on Linux) as a last-resort fallback (best-effort, 2s timeout, never throws).
- **Fetch Relay** (`fetch-relay` mode, opt-in) — an application-layer relay such as a Cloudflare Worker (`FreeLLMAPI -> Relay -> provider`), selected with `PROXY_MODE=fetch-relay` + `PROXY_URL` (relay URL) + `FETCH_RELAY_TOKEN` bearer (`Fetch-Relay-Target`/`Fetch-Relay-Authorization` hop headers, encrypted at rest, `FETCH_RELAY_TOKEN` env precedence, loopback guard, streaming without buffering or auto-redirect) — see [01-fetch-relay.md](01-fetch-relay.md).

For inbound traffic, `TRUST_PROXY` (`server/src/lib/config.ts:95` `parseTrustProxy`) controls Express `trust proxy` (`false` default — do not trust `X-Forwarded-For`/`X-Forwarded-Proto`; `true` — trust all; `<hops>` number — trust that many hops from the socket peer; comma-separated `addr/CIDR` list — trust only those) so analytics and `PROXY_RATE_LIMIT_RPM`/`ADMIN_RATE_LIMIT_RPM` see the real client IP behind a reverse proxy (Caddy/nginx/Traefik).

Related: the full `.env` surface is in [`../env/01-variables.md`](../env/01-variables.md) and the forward-proxy chain is expanded in [`../env/03-outbound-proxies.md`](../env/03-outbound-proxies.md); provider routing and failover that consumes the proxy lives in [`../architecture/`](../architecture/OVERVIEW.md); the Cloudflare Worker reference is in [`../../../examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md).

## File index

| File | Description |
| --- | --- |
| [01-fetch-relay.md](01-fetch-relay.md) | Fetch Relay transport: `FreeLLMAPI -> Fetch Relay -> provider`, `PROXY_MODE=fetch-relay` (`forward` default), `PROXY_URL` as relay URL, `FETCH_RELAY_TOKEN` (encrypted at rest, env precedence, empty=unauthenticated), `Fetch-Relay-Authorization: Bearer <relay-token>` + `Fetch-Relay-Target: <provider-url>` hop headers, loopback-https guard, streaming/manual-redirect, Cloudflare Worker (`examples/fetch-relay-worker/`) reference. |
| [CHANGELOG.md](CHANGELOG.md) | Doc revision history for this domain. |

## Conventions

- Sources: [`.env.example`](../../../.env.example) proxy block (lines 70-80: `PROXY_MODE`, `PROXY_URL`, `FETCH_RELAY_TOKEN`), [`server/src/lib/proxy.ts`](../../../server/src/lib/proxy.ts) (`PROXY_MODES`, `detectSystemProxy` `scutil`/`registry`/`gsettings`, `fetchRelayFetch`, `isLoopbackRelayHostname`/`fetchRelayUrlError`), [`server/src/lib/config.ts`](../../../server/src/lib/config.ts) (`parseTrustProxy` at line 95), [`examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md).
- `forward` remains the default `PROXY_MODE`; `fetch-relay` overwrites caller-supplied `Fetch-Relay-*` headers, strips them before fetching the target, rejects local/metadata destinations and relay loops, handles redirects manually, avoids cookies, never logs credentials, and streams rather than buffers bodies.

## Navigation

- ← [Documentation root](../README.md)
- ↔ [Environment domain](../env/OVERVIEW.md)
- Outbound proxy detail: [`../env/03-outbound-proxies.md`](../env/03-outbound-proxies.md)
- Worker reference: [`../../../examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md)
