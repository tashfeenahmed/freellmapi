[English](../../en/proxy/OVERVIEW.md) · **简体中文**

# 代理域 —— 概览与文件索引

## 范围

本域文档描述 FreeLLMAPI 的出站代理传输方式以及相关的入站 `TRUST_PROXY` 处理。发往提供方的流量可通过两种传输方式离开网关：

- **正向代理**（`forward` 模式，默认）—— 传统的 CONNECT/SOCKS 代理，经由 `PROXY_URL`（显式 `PROXY_URL` → 仪表盘 密钥 → 出站代理设置 → `ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`，小写拼写同样会被读取），支持协议 `http`/`https`/`socks4`/`socks4a`/`socks5`/`socks5h`（带 `h`/`a` 的表示在代理端而非本地解析 DNS），`NO_PROXY` 直连豁免，按密钥覆盖，以及 Docker `host.docker.internal` 坑点。未做任何配置时，链会回落到**系统自动检测**（`server/src/lib/proxy.ts:52-414` 中的 `detectSystemProxy` —— macOS 上 `scutil --proxy`，Windows Internet Options 注册表 `ProxyEnable`/`ProxyServer`，Linux 上 GNOME `gsettings` `manual` + `http host/port`）作为最后的兜底（尽力而为，2 秒超时，永不抛异常）。
- **Fetch Relay**（`fetch-relay` 模式，按需启用）—— 应用层中继，例如 Cloudflare Worker（`FreeLLMAPI -> Relay -> 提供方`），通过 `PROXY_MODE=fetch-relay` + `PROXY_URL`（中继 URL）+ `FETCH_RELAY_TOKEN` bearer（`Fetch-Relay-Target`/`Fetch-Relay-Authorization` 跳间头，静态加密，`FETCH_RELAY_TOKEN` 环境变量优先，回环防护，无缓冲流式且不自动重定向）启用 —— 见 [01-fetch-relay.md](01-fetch-relay.md)。

入站流量方面，`TRUST_PROXY`（`server/src/lib/config.ts:95` 的 `parseTrustProxy`）控制 Express 的 `trust proxy`（`false` 默认 —— 不信任 `X-Forwarded-For`/`X-Forwarded-Proto`；`true` —— 信任全部；`<hops>` 数字 —— 信任距套接字对端指定跳数；逗号分隔的 `addr/CIDR` 列表 —— 仅信任这些），以便在反向代理（Caddy/nginx/Traefik）之后，分析与 `PROXY_RATE_LIMIT_RPM`/`ADMIN_RATE_LIMIT_RPM` 能看到真实客户端 IP。

相关：完整的 `.env` 全貌见 [`../env/01-variables.md`](../env/01-variables.md)，正向代理链在 [`../env/03-outbound-proxies.md`](../env/03-outbound-proxies.md) 中展开；消费该代理的提供方路由与故障转移位于 [`../architecture/`](../architecture/OVERVIEW.md)；Cloudflare Worker 参考见 [`../../../examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md)。

## 文件索引

| 文件 | 说明 |
| --- | --- |
| [01-fetch-relay.md](01-fetch-relay.md) | Fetch Relay 传输：`FreeLLMAPI -> Fetch Relay -> 提供方`，`PROXY_MODE=fetch-relay`（`forward` 为默认），`PROXY_URL` 作为中继 URL，`FETCH_RELAY_TOKEN`（静态加密，环境变量优先，空值表示未鉴权），`Fetch-Relay-Authorization: Bearer <relay-token>` + `Fetch-Relay-Target: <provider-url>` 跳间头，回环-https 防护，流式/手动重定向，Cloudflare Worker（`examples/fetch-relay-worker/`）参考。 |
| [CHANGELOG.md](CHANGELOG.md) | 本域文档修订历史。 |

## 约定

- 来源：[`.env.example`](../../../.env.example) 代理配置块（70–80 行：`PROXY_MODE`、`PROXY_URL`、`FETCH_RELAY_TOKEN`），[`server/src/lib/proxy.ts`](../../../server/src/lib/proxy.ts)（`PROXY_MODES`、`detectSystemProxy` `scutil`/`registry`/`gsettings`、`fetchRelayFetch`、`isLoopbackRelayHostname`/`fetchRelayUrlError`），[`server/src/lib/config.ts`](../../../server/src/lib/config.ts)（95 行的 `parseTrustProxy`），[`examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md)。
- `forward` 仍是默认的 `PROXY_MODE`；`fetch-relay` 会覆盖调用方传入的 `Fetch-Relay-*` 头，在请求目标前剥离它们，拒绝本地/元数据目的地与中继回环，手动处理重定向，避免 Cookie，永不记录凭据，流式而非缓冲响应体。

## 导航

- ← [文档根目录](../README.md)
- ↔ [环境变量域](../env/OVERVIEW.md)
- 出站代理详情：[`../env/03-outbound-proxies.md`](../env/03-outbound-proxies.md)
- Worker 参考：[`../../../examples/fetch-relay-worker/README.md`](../../../examples/fetch-relay-worker/README.md)
