[English](../../en/api/OVERVIEW.md) · **简体中文**

# API 域 —— 概览与文件索引

本目录镜像 FreeLLMAPI 的 OpenAI 兼容 HTTP 接口及 Anthropic/Gemini 兼容适配层的英文文档。

## 文件索引

| 文件 | 范围 |
|------|-------|
| [`01-rest-api.md`](01-rest-api.md) | OpenAI 兼容端点（`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`、`/v1/models`、流式、工具调用、视觉、Gemini grounding、响应头）及 Anthropic Messages 接口（`/v1/messages`）。 |
| [`02-idempotency.md`](02-idempotency.md) | 非流式 `POST /v1/chat/completions` 上的 `Idempotency-Key` —— `replay` / `409 conflict` / `miss` 三种状态、指纹构成（`model`+`messages`+`temperature`/`top_p`/`max_tokens`/`tools`/`tool_choice`）、SHA-256 键哈希、仅限非流式、在途请求不去重（95bc46f）、24 小时 `IDEMPOTENCY_TTL_MS` 窗口、`X-Routed-Via: idempotency`、curl 重试示例。来源：`server/src/services/idempotency.ts`、`proxy.ts:1793-1835`。 |
| [`CHANGELOG.md`](CHANGELOG.md) | 本域文档修订历史 |

## 导航

- ← [文档根目录](../README.md)
- API 参考：[`01-rest-api.md`](01-rest-api.md)
