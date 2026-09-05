[English](../../en/proxy/CHANGELOG.md) · **简体中文**

# 代理域 —— 变更日志

`docs/proxy/` 的文档修订历史，取自触及出站代理与 Fetch Relay 的提交。最近的在前。

| 提交 | 日期 | 摘要 |
| --- | --- | --- |
| `46ea0de` | 2026-09-02 | feat(proxy): 为反向代理后的客户端 IP 适配 `TRUST_PROXY` (#1041) —— 新增 `TRUST_PROXY`（`false\|true\|<hops>\|addr/CIDR`，`.env.example:306-315`，`server/src/lib/config.ts:95-112` 的 `parseTrustProxy`）并转发给 Express `trust proxy`，使分析与 `PROXY_RATE_LIMIT_RPM`/`ADMIN_RATE_LIMIT_RPM` 在 Caddy/nginx/Traefik 之后能看到真实客户端 IP；默认 `false`（不信任伪造）。 |
| `86368ac` | 2026-09-01 | feat(proxy): 作为最后兜底自动检测系统级代理设置 (#838) —— 新增 `detectSystemProxy()`（`server/src/lib/proxy.ts:52-414` —— macOS 上 `scutil --proxy`，Windows 注册表 `ProxyEnable`+`ProxyServer`，Linux 上 GNOME `gsettings` `manual` + `http host/port`）位于 `PROXY_URL → 仪表盘 → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY → detectSystemProxy() → 直连` 链末尾（`resolveProxySource`），关闭 #353/#1069，尽力而为，2 秒超时，永不抛异常。 |
| `56eb257` | 2026-08-31 | 按需启用的 Fetch Relay 出站传输 (#975) —— 新增 `PROXY_MODE`（`forward` 默认，`fetch-relay` 按需启用，`.env.example:74-78`，`server/src/lib/proxy.ts:52` 的 `PROXY_MODES`）与 `FETCH_RELAY_TOKEN`（bearer，静态加密，空值表示未鉴权但不推荐，环境变量优先于仪表盘，`.env.example:78`，`server/src/lib/proxy.ts:389-417`，`isLoopbackRelayHostname`/`fetchRelayUrlError` 回环-https 防护，`Fetch-Relay-Target`/`Fetch-Relay-Authorization` 头，`fetchRelayFetch` 流式 + 手动重定向，`examples/fetch-relay-worker/` Cloudflare Worker 参考）；初始 `docs/fetch-relay.md`（现为 `docs/en/proxy/01-fetch-relay.md`）包含协议、安全契约与 Worker 详情。 |
| `36850e8` | 2026-08-22 | docs(env): 新增运行时配置参考域 —— 在 `docs/en/env/03-outbound-proxies.md` 中首次加入出站代理文档（优先级 `PROXY_URL → 仪表盘 → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY`，协议支持 `http`/`https`/`socks4`/`socks4a`/`socks5`/`socks5h`，`NO_PROXY` 绕过，Docker `host.docker.internal` 坑点，入站限流旋钮），搭建 `docs/env/` 域脚手架，含 `OVERVIEW.md` + `CHANGELOG.md`。（经 #979 合入） |

使用 `git log --oneline -- docs/proxy/ docs/fetch-relay.md docs/env/03-outbound-proxies.md` 与 `git log --oneline --grep=proxy --grep=relay --grep=TRUST_PROXY` 重新生成。
