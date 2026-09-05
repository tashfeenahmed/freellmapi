[English](../../en/proxy/01-fetch-relay.md) · **简体中文**

# Fetch Relay 传输

FreeLLMAPI 可将发往提供方的 HTTP 请求经由应用层的 Fetch Relay 路由，例如 Cloudflare Worker。与 CONNECT/SOCKS 正向代理不同，中继收到的是普通的已鉴权 HTTP 请求，再去拉取目标并把响应流式传回。

```text
FreeLLMAPI -> Fetch Relay -> 提供方
```

在 **密钥 -> 出站代理** 下选择 `fetch-relay`，填入 Relay URL 与令牌，或为无界面安装做如下配置：

```dotenv
PROXY_MODE=fetch-relay
PROXY_URL=https://relay.example.workers.dev
FETCH_RELAY_TOKEN=generate-a-long-random-token
```

`forward` 仍是默认值。现有的 `PROXY_URL`、`ALL_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY`、SOCKS、按密钥代理、绕过以及 `NO_PROXY` 行为保持不变，除非显式选择了 `fetch-relay`。

## 协议

FreeLLMAPI 将原始方法、正文、提供方请求头以及取消信号发送到 `PROXY_URL`，并附带两个跳间控制头：

```http
Fetch-Relay-Authorization: Bearer <relay-token>
Fetch-Relay-Target: https://api.provider.example/v1/chat/completions
Authorization: Bearer <provider-key>
```

Relay 鉴权与提供方鉴权是刻意分离的。不支持查询字符串与 `{url}` 兼容格式。FreeLLMAPI 会覆盖调用方传入的 Relay 控制头，不缓冲响应体，并要求手动处理重定向，以免重定向意外变成对提供方的直连请求。

仪表盘保存的 Relay 令牌会在静态存储时加密，且设置接口永不回显。支持空令牌以实现有意的未鉴权中继，但不推荐。在无界面部署中，`FETCH_RELAY_TOKEN` 环境变量优先于仪表盘保存的值。

## 安全契约

Relay 可以看到提供方凭据与请求内容。请仅使用由您信任的操作者控制的 Relay。生产环境的 Relay 应当对每个请求做鉴权，在请求目标前移除所有 `Fetch-Relay-*` 头，拒绝本地与元数据目的地，手动处理重定向，避免 Cookie，永不记录凭据或完整的目标 URL，且流式而非缓冲请求体。

## Cloudflare Worker 参考

[`examples/fetch-relay-worker`](../../../examples/fetch-relay-worker/README.md) 包含一个与提供方无关的单文件 Worker。它不维护目标站点列表：每个请求都在 `Fetch-Relay-Target` 中携带完整的公开 HTTP(S) 目标。实现通过 Cloudflare 密钥做鉴权，拦截明显的 SSRF 目的地与中继回环，剥离跳间头与 Cookie，不跟随重定向而是暴露重定向位置，并输出经过脱敏的结构化日志。
