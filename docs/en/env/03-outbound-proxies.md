**English** · [简体中文](../../zh-cn/env/03-outbound-proxies.md)

# Outbound proxies

How FreeLLMAPI routes its provider-bound traffic through proxies, which variables win when several are set, and the Docker networking gotchas that come with that.

Sources: [`.env.example`](../../../.env.example) (proxy block), [`docker-compose.yml`](../../../docker-compose.yml), the container-networking notes in [docs/en/install/01-install.md](../install/01-install.md), the proxy transports in [`../proxy/01-fetch-relay.md`](../proxy/01-fetch-relay.md) / [`../proxy/OVERVIEW.md`](../proxy/OVERVIEW.md) (`server/src/lib/proxy.ts:52-414`, `server/src/lib/config.ts:95-110` for `TRUST_PROXY`).

- [Proxy chain precedence](#proxy-chain-precedence)
- [Fetch Relay transport](#fetch-relay-transport-summary)
- [Scheme support](#scheme-support)
- [NO_PROXY bypasses](#no_proxy-bypasses)
- [Docker: 127.0.0.1 is the container](#docker-127001-is-the-container)
- [Related inbound rate-limit knobs](#related-inbound-rate-limit-knobs)

## Proxy chain precedence

Outbound proxy for provider requests is normally set in the dashboard (Keys → Outbound proxy); the env vars exist for headless installs. Resolution is centralized in `resolveProxySource()` (`server/src/lib/proxy.ts:124-143`) — when several sources are present, this is who wins:

```
PROXY_URL → dashboard setting (proxy_url) → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY → detectSystemProxy() → direct
```

`PROXY_MODE` (`server/src/lib/proxy.ts:52` `PROXY_MODES = ['forward','fetch-relay']`, `.env.example:70-78`) selects *how* the winning URL is used, not its position in the chain: `forward` (default) is the ordinary forward proxy (HTTP/SOCKS via undici `ProxyAgent` / `SocksProxyAgent`); `fetch-relay` (opt-in) interprets the same winning URL as an application-layer relay endpoint that forwards with `Fetch-Relay-Target` / `Fetch-Relay-Authorization` headers (`server/src/lib/proxy.ts:53-54,875-900`). A legacy `PROXY_URL` or ambient standard var without an explicit `PROXY_MODE=fetch-relay` always stays `forward` regardless of a saved dashboard mode (`server/src/lib/proxy.ts:310-312,377-382`). See [`../proxy/01-fetch-relay.md`](../proxy/01-fetch-relay.md) for the relay contract (owned by another writer; link assumes it will exist).

`PROXY_URL` stays highest; the dashboard beats the generic environment variables; the final fallback is system auto-detect (commit `86368ac`, closes #353/#1069) — reads the OS-wide proxy so the app works without duplicating OS config. Never per request; evaluated once at boot and on `PUT /api/settings/proxy`, and again via `restoreProxySettings()`. Best-effort and never throws — failure falls through to direct.

The standard variables are also read in their lower-case spellings (`all_proxy`, `https_proxy`, `http_proxy`) via `readEnv()` (`server/src/lib/proxy.ts:109-112`).

| Variable | Role in the chain |
| --- | --- |
| `PROXY_URL` | Explicit FreeLLMAPI proxy setting; highest precedence. Checked via `readEnv('PROXY_URL')` (upper- or lower-case). |
| Dashboard setting | Keys → Outbound proxy (`getSetting('proxy_url')`); beats the generic environment variables — a proxy deliberately typed into the UI must not be silently overridden by a machine-wide `ALL_PROXY` exported for curl/git. |
| `ALL_PROXY` | Standard catch-all proxy variable. |
| `HTTPS_PROXY` / `HTTP_PROXY` | Conventional per-scheme variables, lowest of the explicit env vars. |
| `detectSystemProxy()` system fallback | Last-resort only (`server/src/lib/proxy.ts:52-414`, `detectSystemProxy` / `parseScutilProxy` / `parseRegProxy` / `parseGsettingsProxy`): macOS `scutil --proxy` (`HTTPEnable`/`HTTPProxy`/`HTTPPort` or `SOCKSEnable`/`SOCKSProxy`/`SOCKSPort`), Windows registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable` + `ProxyServer`, `http=` entry preferred), Linux GNOME `gsettings` (`org.gnome.system.proxy` `mode == 'manual'` plus `org.gnome.system.proxy.http` host/port). `execFileSync` 2s timeout, never throws, failure → direct. Source labels `system(macOS)` / `system(Windows)` / `system(GNOME)`. |

## Fetch Relay transport (summary)

For the full application-layer Fetch Relay transport (`PROXY_MODE=fetch-relay`, `PROXY_URL` as relay URL, `FETCH_RELAY_TOKEN` bearer), see [`../proxy/01-fetch-relay.md`](../proxy/01-fetch-relay.md). The forward proxy (`PROXY_MODE=forward`, default) is the traditional `http`/`https`/`socks` CONNECT/SOCKS path documented below; the relay is opt-in and uses `Fetch-Relay-Target`/`Fetch-Relay-Authorization` hop headers, encrypted-at-rest token handling (`encodeFetchRelayToken` → `encrypt()` JSON envelope), `FETCH_RELAY_TOKEN` env precedence over DB (`readEnv('FETCH_RELAY_TOKEN') || dbValue`), `isLoopbackRelayHostname` loopback guard, and the `examples/fetch-relay-worker/` Cloudflare Worker reference. `PROXY_MODE` and `FETCH_RELAY_TOKEN` are documented in detail in the proxy domain and in [01-variables.md](01-variables.md#outbound-proxies) — this page keeps the forward-proxy chain, scheme support, per-key overrides, `NO_PROXY`, loopback guard, and Docker gotchas.

## Per-key proxy overrides

`#590` — each API key can route through its own exit IP (geo-ban / risk-control avoidance). The override rides request-scoped `AsyncLocalStorage` (`perKeyProxyStore`, `withKeyProxy(proxyUrl, fn)` `server/src/lib/proxy.ts:15-20`, `dispatchFetch` `821-841`):

- `resolvePerKeyDispatcher()` keeps a bounded LRU map (`PER_KEY_CACHE_MAX = 32`, evicts oldest; failed builds cached briefly `PER_KEY_FAILURE_TTL_MS = 30s`) keyed by the key's proxy URL — unlike the global dispatcher (TTL 30s), a per-key entry cannot go stale because the URL is the key.
- A per-key override says *which* proxy to use, not *that* the request must be proxied — the same bypasses still apply: global `proxy_enabled == false`, `proxy_bypass` per-platform list, `NO_PROXY`, and local/LAN destinations still go direct. Failure to build a per-key dispatcher falls through to the global proxy or direct.
- Configured per key in the dashboard/API (`proxy_url` on the key row); same `http`/`https`/`socks*` schemes and redaction apply.

## Scheme support

Accepted schemes: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.

The `h`/`a` variants (`socks5h`, `socks4a`) resolve DNS at the proxy rather than locally, which is what you want on a DNS-poisoned network. Example:

```env
PROXY_URL=socks5h://127.0.0.1:1080
```

> **Fetch-Relay note:** when `PROXY_MODE=fetch-relay` (`server/src/lib/proxy.ts:52` `PROXY_MODES`), the winning URL is treated as an application-layer relay endpoint and must be `http`/`https` — SOCKS schemes are rejected at boot by `enforceRelayUrlPolicy()` (`server/src/lib/proxy.ts:339-350`), and plain `http` is only allowed for loopback relays (`isLoopbackRelayHostname` — `localhost`, `127.0.0.1`, `::1`/`[::1]`, `127.*`, `fetchRelayUrlError()` `server/src/lib/proxy.ts:71-81`). Encrypted-at-rest token handling and env precedence (`FETCH_RELAY_TOKEN` → `readEnv('FETCH_RELAY_TOKEN') || dbValue`, `encodeFetchRelayToken`/`decodeFetchRelayToken` `389-417`) are detailed in [01-variables.md](01-variables.md#outbound-proxies) and [`../proxy/01-fetch-relay.md`](../proxy/01-fetch-relay.md).

## NO_PROXY bypasses

`NO_PROXY` lists hosts that must be reached directly, bypassing whichever proxy won above (`parseNoProxy` / `noProxyMatches` `server/src/lib/proxy.ts:223-251`):

```env
NO_PROXY=localhost,127.0.0.1,.internal.corp
```

- Comma-separated entries, trimmed, lower-cased, `*.` prefix stripped to `.`.
- A bare domain also covers its subdomains (`example.com` matches `api.example.com`); a leading `.` explicitly covers the suffix.
- A `host:port` entry narrows to that port (bare `host` compared).
- Trailing dot (FQDN form) and IPv6 brackets are ignored for matching.
- The special value `*` disables the proxy entirely (matches any host).

Parsed once in `applyProxyUrl()` from `readEnv('NO_PROXY')` (`server/src/lib/proxy.ts:313`).

## Loopback and LAN guard

`shouldBypassProxy(url, platform)` (`server/src/lib/proxy.ts:472-486`) returns direct when any holds:

- proxy disabled globally (`applyProxyEnabled(false)` / `_proxyEnabled`);
- `platform` listed in `proxy_bypass` (`applyProxyBypass`);
- `NO_PROXY` matches the upstream hostname;
- upstream hostname is loopback or private/LAN and `FREEAPI_PROXY_LOCAL_DESTINATIONS` is not set (`server/src/lib/proxy.ts:262-263,314`).

By default **local and LAN destinations always bypass the proxy** — a remote proxy has no route back to `localhost`/`127.0.0.0/8`/`::1`/`0.0.0.0` or RFC1918/ULA/CGNAT addresses, and an IP literal must go on the wire as SOCKS ATYP `0x01` no matter what `socks5h` promises, so Tor logs “giving Tor only an IP address” and may refuse. That is the right default for local Ollama / llama.cpp / LM Studio.

Set `FREEAPI_PROXY_LOCAL_DESTINATIONS=true` (checked case-insensitive `1|true|yes`) only when proxying a local address *is* the point — e.g. `ssh -D` dynamic tunnel where `http://127.0.0.1:11434` through SOCKS should resolve at the remote end.

### Fetch-Relay loopback hostnames

A Fetch Relay carries the provider API key *and* the relay token inside the forwarded request, so the hop to the relay must be encrypted. `fetchRelayUrlError()` (`server/src/lib/proxy.ts:71-81`) allows `http` only for loopback relay hostnames:

```ts
isLoopbackRelayHostname(hostname): localhost, 127.0.0.1, ::1, [::1], 127.*  // server/src/lib/proxy.ts:59-66
```

Otherwise `https` is required; plaintext to a remote host earns `Fetch Relay URL must use https, or http only for a loopback relay.` at boot. The same guard is shared by the settings validator so the dashboard and headless installs agree.

> **Callout — inbound vs outbound proxy.**
> The outbound chain above (`PROXY_URL`, dashboard, `ALL_PROXY`, … `detectSystemProxy()`, per-key proxy, `NO_PROXY`, loopback guard) steers **FreeLLMAPI → provider** traffic. `TRUST_PROXY` steers the opposite direction — **client → FreeLLMAPI** — by telling Express whether to trust `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy (Caddy/nginx/Traefik). They are independent knobs; setting one does not imply the other. See `server/src/lib/config.ts:95-110` `parseTrustProxy()` vs `server/src/lib/proxy.ts:52-414` outbound chain.

See also [`../proxy/OVERVIEW.md`](../proxy/OVERVIEW.md) for the full transport scope.

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

## TRUST_PROXY: inbound vs outbound

> **Inbound vs outbound — different directions.**
> Outbound (`PROXY_URL`, dashboard, `ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `detectSystemProxy()`, per-key proxy, `NO_PROXY`, loopback guard) controls **FreeLLMAPI → provider** egress. `TRUST_PROXY` controls **client → FreeLLMAPI** ingress: whether Express trusts `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy so Analytics and the per-IP rate limiters see the real client. One does not imply the other.
>
> | Outbound | `PROXY_URL` / `ALL_PROXY` / `detectSystemProxy()` etc. | `server/src/lib/proxy.ts:52-414` | Provider-bound traffic |
> | Inbound | `TRUST_PROXY` (`false\|true\|<hops>\|addr/CIDR`, `.env.example:314`) | `server/src/lib/config.ts:95-110` `parseTrustProxy()` → Express `trust proxy` | Client IP for `REQUEST_ANALYTICS_LOG_CLIENT` + `PROXY_RATE_LIMIT_RPM` / `ADMIN_RATE_LIMIT_RPM` |

`TRUST_PROXY` (`server/src/lib/config.ts:95-110`, `.env.example:306-315`) is forwarded to Express `trust proxy` in `server/src/app.ts`:

| `TRUST_PROXY` value | `trustProxy` | Effect |
| --- | --- | --- |
| unset / empty / `false` / `no` / `0` | `false` | **Do not trust** forwarded headers — `X-Forwarded-For` ignored, direct callers cannot spoof `clientIp`; analytics + limiters count the socket peer. **Default, safe without a reverse proxy.** |
| `true` / `yes` | `true` | Trust every hop — only on fully trusted network. |
| non-negative integer e.g. `1` | `1` (number) | Trust that many hops from socket peer — Express idiom `trust proxy: 1` for one proxy in front. `0` → `false`. |
| comma-separated addresses/CIDRs e.g. `100.64.0.0/10,192.168.1.10` | `string[]` | Trust only those proxy addresses/CIDRs. |

When trusted, `client-context` (`server/src/lib/client-context.ts`) and limiters read the left-most untrusted `X-Forwarded-For` entry, so Caddy/nginx/Traefik is not counted as client. When untrusted, socket peer is client regardless of `X-Forwarded-For` — safe default for direct installs. Commit `46ea0de` (#1041, closes #1024). Also see [`../proxy/OVERVIEW.md`](../proxy/OVERVIEW.md) and [01-variables.md](01-variables.md#rate-limits).

## Related inbound rate-limit knobs

Despite the shared “proxy” name, these two variables throttle *inbound* traffic to FreeLLMAPI itself, not outbound provider calls. They count the **real client IP** when `TRUST_PROXY` is set, otherwise the socket peer:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_RATE_LIMIT_RPM` | `120` | Max `/v1` proxy requests per minute per client IP. `0` disables. |
| `ADMIN_RATE_LIMIT_RPM` | `600` | Max `/api` dashboard requests per minute per client IP — a flood guard; login has its own per-email lockout and key export its own much tighter cap. `0` disables. |

Full descriptions live in [01-variables.md](01-variables.md#rate-limits).
