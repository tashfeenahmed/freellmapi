## 0. 执行前判断

**复杂度结论：** 复杂需求（涉及 4 层、6+ 文件、新依赖、接口扩展）

**Design 是否存在：** 是

**是否允许直接进入任务拆解：** 是

**Knowledge 是否需要更新：** 否

**说明：** 所有 artifacts 齐全（explore → proposal → specs → design），可直接拆解为原子任务。

## 0.1 Knowledge 更新任务

无需更新 knowledge 文档。本 change 不涉及现有 knowledge 的修改。

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为
- [x] 0.2.4 不修改现有 OpenAI 端点（`/v1/chat/completions`）的任何行为
- [x] 0.2.5 不修改现有 `ChatMessage` 类型定义
- [x] 0.2.6 不修改现有 Provider 实现（GoogleProvider、OpenAICompatProvider 等）
- [x] 0.2.7 不实现 context handoff 对 Anthropic 端点的支持
- [x] 0.2.8 不实现 `cache_control` prompt caching
- [x] 0.2.9 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施

---

## 1. 依赖与类型基础

**关联规格：** 所有 capabilities

**关联设计决策：** "内部 Anthropic 类型来源"

**涉及文件或模块：**
- `server/package.json`
- `shared/anthropic-types.ts`

**验收方式：** TypeScript 编译通过，类型导入成功

**回滚方式：** `git revert`

- [x] 1.1 在 `server/package.json` 添加 `@anthropic-ai/sdk` 依赖
- [x] 1.2 运行 `npm install` 安装依赖
- [x] 1.3 创建 `shared/anthropic-types.ts`：从 `@anthropic-ai/sdk` re-export 所需的类型（`Message`、`MessageParam`、`ContentBlock`、`ContentBlockParam`、`TextBlock`、`ToolUseBlock`、`RawMessageStreamEvent`、`StopReason` 等）
- [x] 1.4 在 `shared/anthropic-types.ts` 中定义内部辅助类型：`MessagesOptions`（provider 调用参数）、`AnthropicStreamEvent`（流式事件联合类型）
- [x] 1.5 `npm run build -w server` — 验证编译通过

---

## 2. 协议转换器（非流式）

**关联规格：**
- `message-translation` — 所有 requirements

**关联设计决策：**
- "Protocol 转换位置" — 在 BaseProvider 默认实现中调用
- "错误格式" — 使用 Anthropic API error format

**涉及文件或模块：**
- `server/src/lib/anthropic-adapter.ts`

**验收方式：** 单元测试覆盖所有消息类型转换场景

**回滚方式：** 删除文件

- [x] 2.1 创建 `server/src/lib/anthropic-adapter.ts`
- [x] 2.2 实现 `anthropicToOpenAI()`：
  - system 字段 → system message 插入 messages 头部
  - user + text content → `{role:"user", content:string}`
  - user + image content → `{role:"user", content:ChatContentBlock[]}`
  - user + tool_result → `{role:"tool", content, tool_call_id}`
  - assistant + text → `{role:"assistant", content:string}`
  - assistant + tool_use → `{role:"assistant", content:null, tool_calls:[...]}`
  - tools 定义 → 添加 `type:"function"` wrapper
  - tool_choice 映射
  - top-level 参数透传（temperature, max_tokens, top_p, stop）
- [x] 2.3 实现 `openAIToAnthropicResponse()`：
  - `choices[0].message.content` → `content: [{type:"text", text}]`
  - `tool_calls` → `content: [{type:"tool_use", id, name, input}]`
  - `finish_reason` 映射（stop→end_turn, tool_calls→tool_use, length→max_tokens）
  - `usage` 字段映射（prompt_tokens→input_tokens, completion_tokens→output_tokens）
  - 空 content 容错
- [x] 2.4 创建 `server/src/__tests__/lib/anthropic-adapter.test.ts` — 覆盖所有 spec scenarios

---

## 3. 流式适配器

**关联规格：**
- `anthropic-streaming` — 所有 requirements

**关联设计决策：**
- "流式适配器实现" — 自定义状态机

**涉及文件或模块：**
- `server/src/lib/anthropic-stream.ts`

**验收方式：** 单元测试覆盖所有 SSE 事件路径

**回滚方式：** 删除文件

- [x] 3.1 创建 `server/src/lib/anthropic-stream.ts`
- [x] 3.2 实现 `openAIChunksToAnthropicEvents()` AsyncGenerator：
  - INIT 状态：缓冲 preamble chunks
  - 首次 text content → 发 message_start + content_block_start(text) + content_block_delta
  - 后续 text delta → 发 content_block_delta
  - tool_call delta → 缓存到 Map<index, {id, name, args}>
  - 检测到 tool_calls 出现 → 发当前 text block 的 content_block_stop，发 tool_use 的 content_block_start + deltas + content_block_stop
  - 多 tool_use 按 index 排序
  - finish_reason → 发 message_delta (stop_reason + usage) + message_stop
  - 空完成检测 → 抛出 `"empty completion"` error
- [x] 3.3 实现错误处理：
  - message_start 前出错 → 抛出 retryable error
  - message_start 后出错 → 发 `{type:"error", error:{...}}` 事件
- [x] 3.4 创建 `server/src/__tests__/lib/anthropic-stream.test.ts` — 覆盖所有 spec scenarios：
  - 纯文本、带 tool_use、多 tool_use、空完成、流中断

---

## 4. BaseProvider 双协议扩展

**关联规格：**
- `provider-dual-protocol` — 所有 requirements

**关联设计决策：**
- "BaseProvider 扩展方式" — 带默认实现的基类方法

**涉及文件或模块：**
- `server/src/providers/base.ts`

**验收方式：** TypeScript 编译通过，现有测试全通过，新增 provider 测试通过

**回滚方式：** `git revert`

- [x] 4.1 在 `BaseProvider` 中添加 `MessagesOptions` 接口定义
- [x] 4.2 添加 `messages(apiKey: string, options: MessagesOptions): Promise<AnthropicMessage>` 方法（带默认实现：调用 anthropicToOpenAI → chatCompletion → openAIToAnthropicResponse）
- [x] 4.3 添加 `streamMessages(apiKey: string, options: MessagesOptions): AsyncGenerator<AnthropicStreamEvent>` 方法（带默认实现：调用 anthropicToOpenAI → streamChatCompletion → openAIChunksToAnthropicEvents）
- [x] 4.4 `npm run build -w server` — 验证编译通过
- [x] 4.5 创建 `server/src/__tests__/providers/anthropic-default-impl.test.ts` — 验证默认实现端到端正确

---

## 5. 共享函数提取

**关联规格：** 所有 capabilities

**关联设计决策：** "端点层" — 与 proxy.ts 代码共享

**涉及文件或模块：**
- `server/src/routes/proxy.ts`

**验收方式：** 现有测试全通过

**回滚方式：** `git revert`

- [x] 5.1 在 `proxy.ts` 中将 `extractApiToken` 和 `timingSafeStringEqual` 添加 `export` 前缀（已 export，验证可导入）
- [x] 5.2 在 `lib/content.ts` 中导出 `estimateTokens(messages: ChatMessage[]): number` 函数
- [x] 5.3 运行现有测试：`npm test -w server` — 全部通过

---

## 6. /v1/messages 端点

**关联规格：**
- `anthropic-endpoint` — 所有 requirements

**关联设计决策：**
- "Protocol 转换位置" — 端点调用 provider 默认实现
- "错误格式" — Anthropic error format

**涉及文件或模块：**
- `server/src/routes/anthropic.ts`
- `server/src/app.ts`

**验收方式：** 端点级别测试 + 手动 Claude Code 验证

**回滚方式：** 删除文件 + 删除 app.ts 中的注册行

- [x] 6.1 创建 `server/src/routes/anthropic.ts`
- [x] 6.2 实现 `POST /messages` 端点：
  - 认证：`extractApiToken()` + `timingSafeStringEqual()`
  - `anthropic-version` header 检查（日志警告，不阻塞）
  - Zod 验证：`model`（optional, default "auto"）, `messages`（min 1）, `max_tokens`（must > 0）, `system`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `tools`, `tool_choice`, `stream`, `metadata`
  - 图像检测：遍历 content blocks 检查 image type
  - 工具检测：检查 tools 是否存在
  - Token 估算
  - `routeRequest()` 调用 — 共享路由
  - 重试循环（复用 proxy.ts 的 retryable error 判断逻辑）
  - 非流式：`provider.messages()` → 返回 AnthropicMessage JSON
  - 流式：`provider.streamMessages()` → SSE 转发
    - 头缓存直到第一个事件
    - `X-Routed-Via` 和 `X-Fallback-Attempts` headers
    - `data: {JSON}\n\n` 格式
  - 错误响应：Anthropic API error format `{type:"error", error:{type, message}}`
- [x] 6.3 在 `server/src/app.ts` 中注册 `anthropicRouter`：`app.use('/v1', anthropicRouter)`（在 `app.use('/v1', proxyRouter)` 和 `app.use('/v1', responsesRouter)` 之后）
- [x] 6.4 创建 `server/src/__tests__/routes/anthropic.test.ts` — 端点级测试：
  - 认证（有效 key → 200, 无效 key → 401, x-api-key header 认证）
  - 请求验证（缺少 max_tokens → 400, 空 messages → 400）
  - 图像 fallback（无 vision 模型 → 422）
  - 工具 fallback（无 tools 模型 → 422）
  - 非流式成功响应格式验证
  - 流式 SSE 事件序列验证（mock provider）

---

## 7. 编译与回归

**关联规格：** 所有 capabilities

**涉及文件或模块：** 全部

**验收方式：** `npm run build && npm test` 全绿

**回滚方式：** `git revert`

- [x] 7.1 `npm run build -w server` — 验证 TypeScript 编译通过
- [x] 7.2 `npm test -w server` — 验证所有测试通过（现有 + 新增）
- [x] 7.3 检查是否有未使用的 import 或 dead code — 清理本 change 引入的
- [x] 7.4 确认 `shared/types.ts` 无修改 — 保持向后兼容

---

## 8. 手动验证（Claude Code）

**关联规格：**
- `anthropic-endpoint`
- `message-translation`
- `anthropic-streaming`

**验收方式：** 手动运行 Claude Code 指向 freellmapi

**回滚方式：** `git revert`

- [ ] 8.1 启动 freellmapi server
- [ ] 8.2 配置 Claude Code 使用自定义 provider：
  - `apiKey` 设置为 freellmapi 的 unified API key
  - `baseURL` 设置为 `http://localhost:3001/v1`（或实际端口）
- [ ] 8.3 测试简单对话（非流式 + 流式）
- [ ] 8.4 测试工具调用（要求 Claude Code 执行代码相关的任务）
- [ ] 8.5 观察日志确认路由、fallback、sticky session 正常工作

---

## 99. 最终自检

- [ ] 所有任务都能追溯到 requirement、design decision 或 knowledge 更新项
- [ ] 每个任务都有明确验收方式
- [ ] 未包含无关重构、顺手优化或未授权范围
- [ ] 已列出必要测试、验证和回滚任务
- [ ] 无开放问题阻塞实施
