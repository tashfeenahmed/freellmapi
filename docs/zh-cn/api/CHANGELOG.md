[English](../../en/api/CHANGELOG.md) · **简体中文**

# API 域 —— 变更日志

`docs/api/` 的文档修订历史。最近的在前。

## 2026-10-23

- **fix(api)：客户端档案密钥现在可通过 `/v1/messages` 与 `/v1beta` 鉴权** —— #411 的 `sk-cp-*` 密钥此前只被 `/v1/chat/completions` 与 `/v1/responses` 接受；Anthropic 与 Gemini 路由仍只比对统一密钥，导致下游应用拿着自己的档案密钥得到 `401`。两条路由现在都经由 `resolveAuth` 解析：档案密钥携带其服务端强制系统提示词（最先注入——`/v1/messages` 在压缩之后、`/v1beta` 在 `systemInstruction` 之前——排序契约一致），被禁用的档案按坏密钥处理。来源：`server/src/routes/anthropic.ts`、`server/src/routes/gemini.ts`。

## 2026-08-23 —— 文档重组

- **36850e8** `docs(api): fold API guide into api domain` — `docs/api.md` → `docs/api/01-rest-api.md`，补 `OVERVIEW.md` + `CHANGELOG.md` 脚手架。（经 #979 合入）
