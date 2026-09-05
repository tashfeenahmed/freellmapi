[English](../../en/troubleshooting/01-common-issues.md) · **简体中文**

# 常见问题

## Docker 容器无法访问提供方

**现象：** 容器内访问 `127.0.0.1:11434`（Ollama）或 `localhost` 时出现 `ECONNREFUSED` 或超时，宿主机却可达。

**原因：** 容器内的 `127.0.0.1` 指向容器本身，而非宿主机。参见 `deployment/01-docker.md` 中 container-cannot-reach-providers 坑点。

**修复：** 在 Docker Desktop 上使用 `host.docker.internal`，Linux 上使用 `172.17.0.1` 或宿主机局域网 IP，并确保代理（Clash / v2rayN / sing-box）监听 `0.0.0.0` 而非 `127.0.0.1`。Compose 的 `host-gateway` 映射：`extra_hosts: ["host.docker.internal:host-gateway"]`。

**诊断：** `docker exec freellmapi curl -v http://host.docker.internal:11434/api/tags`。

## 空链 `400`

**现象：** `POST /v1/chat/completions` 返回 `400 active chain is empty`（或 fallback ladder empty）。

**原因：** 活跃的回退链存在但未启用任何模型——自 `e852ff1` / `b3bf20f` 起，空链被视为权威配置，不再静默回退到目录全量。

**修复：** 打开 `Fallback` 页面 → 在活跃链中启用模型，或设置 `profiles.auto_include_new_models=1`，或切换活跃 profile。参见 `fallback/01-named-chains.md`。

## Fetch Relay 环回防护

**现象：** 使用 `PROXY_MODE=fetch-relay` 时返回 `fetchRelayUrlError` 或 `isLoopbackRelayHostname` 400。

**原因：** 环回 `PROXY_URL`（`127.0.0.1`、`::1`）被 `enforceRelayUrlPolicy` 拦截，除非显式放行；fetch-relay 拒绝 SOCKS（仅支持 `http` / `https`，且 `http` 仅允许环回）。

**修复：** 使用公开的 `https://relay.example.workers.dev` URL。本地测试时检查 `server/src/lib/proxy.ts:339-350` 中的策略。参见 `proxy/01-fetch-relay.md`。

## 幂等 `409` 冲突

**现象：** 重试时返回 `409 Idempotency-Key already used with different request`。

**原因：** 同一个 `Idempotency-Key` 携带了不同的指纹（`model` / `messages` / `temperature` / `top_p` / `max_tokens` / `tools` / `tool_choice` 有差异）。参见 `api/02-idempotency.md`。

**修复：** 为每个不同的请求使用全新的 UUID，或重放完全相同的请求体。进行中窗口不会去重（`95bc46f`）—— 使用相同 key 的并发重试仍可能竞态。

## 额度面板显示陈旧或排序延迟

**现象：** 额度面板更新缓慢或显示大量行。

**修复：** `QUOTA_OBSERVATIONS_RETENTION_DAYS=30` / `QUOTA_OBSERVATIONS_MAX_ROWS=200000` 会以 `5k` / `250ms` 为块每日清理（`4a8f095`）；请确保数据库位于高速卷上。检查 `server/src/services/request-retention.ts:68-137` 与 `provider-quota.ts:532-586` 中相关的 `LIMIT 1` 索引查找。

## 密码重置验证码不可见（桌面端）

**现象：** `POST /api/auth/forgot-password` 在控制台打印了一次性验证码，但桌面应用未显示。

**原因：** 从 Finder / Explorer 启动的 Electron 没有附加 `stdout`。

**修复：** 打开托盘 → `Open Logs Folder` → `freeapi.log`（`desktop/src/logger.ts` 的 tee，`installFileLogger` 在 server 启动前安装）。或使用 `docker logs`。

## 更新检查显示无更新 / 未签名构建无法自动更新

**现象：** 仪表盘检查器显示 `latest > running`，但 `Squirrel.Mac` 拒绝更新，或 DMG 自动更新失败。

**原因：** `Squirrel.Mac` 会校验代码签名。未带证书的本地 `npm run dist` 能产出应用，但不会产生有效的更新源（`desktop/02-logging-and-updates.md`）。DMG 在 `Apple stapler` 公证后需经 `refresh-mac-update-metadata.mjs` 重新盖戳。

**修复：** 从 GitHub Releases 下载已签名的发布包，或使用 `CSC_*` / `APPLE_ID` 进行签名。

## 反向代理 `TRUST_PROXY` 未获取到真实客户端 IP

**现象：** 分析 / 限流显示 `127.0.0.1` 而非真实客户端。

**原因：** `TRUST_PROXY` 默认 `false`（防伪造）。

**修复：** 单个反向代理（与宿主机同机的 Caddy / nginx / Traefik）设为 `TRUST_PROXY=1`，或使用 CIDR 列表（`TRUST_PROXY=100.64.0.0/10,192.168.1.10`）。参见 `env/01-variables.md` 中 `TRUST_PROXY` 与 `server/src/lib/config.ts:95-110` 的 `parseTrustProxy()`。

## 相关

- [桌面端](../desktop/OVERVIEW.md) — `freeapi.log` 轮转。
- [代理传输](../proxy/OVERVIEW.md) — fetch-relay 协议。
- [环境变量](../env/01-variables.md) — 全部配置项。
