<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## MODIFIED Requirements

### Requirement: 维护者通过 POST /api/models 添加任意 provider 的模型

The system SHALL provide `POST /api/models` with two mutually exclusive body shapes: Form A (generic provider, legacy) and Form B (custom multi-key write via `keyIds[]`). For Form A with `platform='custom'` without `keyIds`, the system SHALL return 400 guiding the caller to Form B.

系统 SHALL 提供 `POST /api/models` 接口，支持两种互斥的请求体形态：

**形态 A（通用 provider，原行为）**：body 必填 `platform`、`modelId`；可选字段为 `displayName`、`contextWindow`、`supportsVision`、`supportsTools`。系统 SHALL 拒绝未注册的 platform（即 `hasProvider(platform) === false`）→ 返回 4xx；在 `(platform, modelId)` 已存在时 SHALL 返回 409 且 MUST NOT 静默覆盖已有行的 `enabled` 状态；写入时 SHALL 设置 `source = 'user'`，且 SHALL 为该模型在 `fallback_config` 中插入一行（`priority = MAX(priority) + 1`，`enabled = 1`）；SHALL 给未提供的字段使用合理默认值（`displayName` 默认等于 `modelId`，`intelligence_rank = 50`，`speed_rank = 50`，`size_label = 'User'`，limits 与 `monthly_token_budget` 为 NULL/默认空值）。**注**：`platform = 'custom'` SHALL NOT 走形态 A；当 body 含 `platform = 'custom'` 但不含 `keyIds` 时，系统 SHALL 返回 400 引导使用形态 B。

**形态 B（custom 多 key 写入，新）**：body 必填 `keyIds: number[]`、`modelId`；可选 `displayName`。系统 SHALL 校验 keyIds 全部存在、属于 `platform='custom'`、共享同一 `base_url`（任一不满足返回 400）；SHALL 在单事务内对每个 keyId 执行 `INSERT INTO models ... ON CONFLICT(platform, model_id) DO UPDATE SET display_name=excluded.display_name`，使用 `model_id = '${keyId}-${modelId}'` 命名约定；写入时 `source = 'user'`、`enabled = 1`、`key_id = keyId`、其他元数据走默认值；新插入行 SHALL 同步获得 `fallback_config` 行；UPDATE 命中已有行时 MUST NOT 重复创建 `fallback_config` 行，且 MUST NOT 修改 `enabled` 字段。响应体 SHALL 等于 `{ created: number[], updated: number[] }`，HTTP 200。

#### Scenario: 形态 A — 成功添加 user 模型
- **WHEN** 维护者 POST `{platform: 'groq', modelId: 'qwen-3-coder-next-512b', displayName: 'Qwen3 Coder Next 512B'}`
- **THEN** 响应 SHALL 返回 201 与新建行的 id；表中 SHALL 存在 `(groq, qwen-3-coder-next-512b, source='user', enabled=1)` 行；`fallback_config` 中 SHALL 存在对应行

#### Scenario: 形态 A — 拒绝未注册 platform
- **WHEN** 维护者 POST `{platform: 'unknown-vendor', modelId: 'X'}`
- **THEN** 响应 SHALL 返回 4xx 错误

#### Scenario: 形态 A — 立即可路由
- **WHEN** 维护者添加 `(groq, X, source='user')` 后立即调用 `/v1/chat/completions` 指定 `model: 'X'`
- **THEN** 系统 SHALL 把该请求路由到 groq provider，无需重启

#### Scenario: 形态 A — 同 (platform, modelId) 冲突返回 409
- **WHEN** 维护者 POST `{platform:'groq', modelId:'X'}`，且该 `(platform, modelId)` 已存在
- **THEN** 响应 SHALL 返回 409，且已有行的 `enabled` 状态 MUST NOT 被覆盖

#### Scenario: 形态 B — 多 key 全新写入
- **WHEN** 同 base_url 下存在 keys [11, 12]，维护者 POST `{ keyIds: [11, 12], modelId: 'qwen3:8b' }`
- **THEN** `models` 表 SHALL 新增两行（`source='user'`），响应 SHALL 等于 `{ created: [<id1>, <id2>], updated: [] }`

#### Scenario: 形态 B — 重复提交触发 UPDATE
- **WHEN** 上一场景之后再次 POST 相同 keyIds 与 modelId 但不同 displayName
- **THEN** 两行的 `display_name` SHALL 被更新；响应 SHALL 等于 `{ created: [], updated: [<id1>, <id2>] }`；`enabled` MUST NOT 被改

#### Scenario: 形态 B — 跨 base_url 拒绝
- **WHEN** keys [11, 13] 跨不同 base_url，维护者 POST `{ keyIds: [11, 13], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400

#### Scenario: 形态 B — 非 custom 平台 keyIds 拒绝
- **WHEN** keys [99] 属于 `platform='groq'`，维护者 POST `{ keyIds: [99], modelId: 'X' }`
- **THEN** 响应 SHALL 返回 400

#### Scenario: 形态 A 上 platform='custom' 引导用户走形态 B
- **WHEN** 维护者 POST `{platform: 'custom', modelId: 'X'}`（无 keyIds）
- **THEN** 响应 SHALL 返回 400，错误消息 SHALL 引导使用 `keyIds[]` 形态
