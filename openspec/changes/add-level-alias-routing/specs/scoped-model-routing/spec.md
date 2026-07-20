## ADDED Requirements

### Requirement: requestedModel 五步解析顺序
**Trace**: proposal.md#scoped-model-routing / 客户端按档位/逻辑模型寻址

系统 SHALL 按固定顺序解析客户端 `model` 字段：先 `auto`/`auto:xxx`（现有 auto 路径），再档位名 `high-level`/`middle-level`/`low-level`（大小写不敏感），再 alias 名（大小写敏感），再精确 `model_id` pin，均未命中返回 400。

#### Scenario: auto 不受影响
- **WHEN** 请求 `model: "auto"` 或 `model: "auto:intelligence"` 或 `model` 缺省
- **THEN** 走现有 `resolveRoutingChain` 路径，行为与现状一致

#### Scenario: 档位名优先于 alias 名
- **WHEN** 存在 alias 名 `high-level`（假设保留字校验被绕过）且请求 `model: "high-level"`
- **THEN** 命中档位路由而非 alias（档位优先）

#### Scenario: alias 名优先于精确 model_id
- **WHEN** 存在 alias 名 `glm5.2`，且某 provider 的 model_id 也叫 `glm5.2`，请求 `model: "glm5.2"`
- **THEN** 命中 alias 路由（展开该 alias 所有成员），不走精确 pin

#### Scenario: 全部未命中返回 400
- **WHEN** 请求 `model: "nonexistent"`，既非 auto、非档位、非 alias、非任何 model_id
- **THEN** 返回 400，error 含 `code: "model_not_found"` 与可用选项提示

### Requirement: 档位路由展开
**Trace**: proposal.md#scoped-model-routing / 客户端按档位寻址

系统 SHALL 在请求 `model` 为档位名时，展开该档位下所有 `enabled=1` 的 alias 的所有 `enabled=1` 成员模型为一条 ChainRow[]，按 `aliases.priority ASC, models.alias_priority ASC` 排序。

#### Scenario: 展开档位链
- **WHEN** high-level 档位下有 alias `glm5.2`(priority=0, 3 成员) 和 `deepseek-v4-pro`(priority=1, 2 成员)，请求 `model: "high-level"`
- **THEN** 路由链为 `[glm5.2/m0, glm5.2/m1, glm5.2/m2, ds-v4-pro/m0, ds-v4-pro/m1]`（按 alias_priority 与 alias.priority 排序）

#### Scenario: 档位名大小写不敏感
- **WHEN** 请求 `model: "High-Level"` 或 `model: "HIGH-LEVEL"`
- **THEN** 命中 high 档位

#### Scenario: 禁用的 alias 不在展开链
- **WHEN** high 档位下 alias `glm5.2` 被 `enabled=false`，请求 `model: "high-level"`
- **THEN** 展开链不含 `glm5.2` 的任何成员

#### Scenario: 空档位返回错误
- **WHEN** 请求 `model: "high-level"` 但该档位下无任何 enabled alias/成员
- **THEN** 返回错误（见"用尽即报错"requirement）

### Requirement: 逻辑模型 alias 路由展开
**Trace**: proposal.md#scoped-model-routing / 客户端按逻辑模型寻址

系统 SHALL 在请求 `model` 为 alias 名时，展开该 alias 下所有 `enabled=1` 成员为 ChainRow[]，按 `models.alias_priority ASC` 排序。alias 名匹配大小写敏感。

#### Scenario: 展开 alias 链
- **WHEN** alias `glm5.2` 有 3 个成员（alias_priority 0/1/2），请求 `model: "glm5.2"`
- **THEN** 路由链为 `[m0, m1, m2]` 按 alias_priority 排序

#### Scenario: alias 名大小写敏感
- **WHEN** 存在 alias `glm5.2`，请求 `model: "GLM5.2"` 且无同名 alias
- **THEN** 不命中该 alias，继续向后尝试精确 model_id pin

#### Scenario: 禁用 alias 不被命中
- **WHEN** alias `glm5.2` 被 `enabled=false`，请求 `model: "glm5.2"`
- **THEN** 不命中该 alias，继续向后尝试精确 model_id pin

### Requirement: 组内优先 failover
**Trace**: proposal.md#scoped-model-routing / 用尽即报错不降级

档位/alias 路由的 failover SHALL 严格按展开链顺序进行：同一 alias 的成员连续排列，全挂才进入下一个 alias（档位路由时），整个展开链用尽才报错。

#### Scenario: 同 alias 内 failover 优先
- **WHEN** 请求 `model: "high-level"`，链 `[glm5.2/m0, glm5.2/m1, glm5.2/m2, ds-v4-pro/m0, ds-v4-pro/m1]`，`glm5.2/m0` 返回 429
- **THEN** 下一次尝试 `glm5.2/m1`（同 alias），而非跨到 `ds-v4-pro/m0`

#### Scenario: alias 全挂才跨组
- **WHEN** 上例中 `glm5.2` 的 m0/m1/m2 全部失败
- **THEN** 下一次尝试 `ds-v4-pro/m0`（下一个 alias）

### Requirement: 用尽即报错不降级
**Trace**: proposal.md#scoped-model-routing / 用尽即报错不降级

档位/alias 路由的展开链全部用尽时，系统 SHALL 返回错误，SHALL NOT 跨档位降级（high 用尽不回退 middle），SHALL NOT 跨 alias，SHALL NOT 回退到全局活动链。用尽错误 SHALL 使用 `code: "scope_exhausted"` 与 HTTP 503，区别于限流 429。

#### Scenario: 档位用尽不降级
- **WHEN** 请求 `model: "high-level"`，high 档位所有成员全部失败/被 skip，middle 档位有可用成员
- **THEN** 返回 503，error 含 `code: "scope_exhausted"` 与 scope 描述（如 "high-level"），不尝试 middle 档位

#### Scenario: alias 用尽不跨组不回退全局
- **WHEN** 请求 `model: "glm5.2"`，该 alias 所有成员全部失败，全局活动链有其他可用模型
- **THEN** 返回 503，error 含 `code: "scope_exhausted"` 与 scope "glm5.2"，不回退全局活动链

#### Scenario: 用尽错误区别于限流
- **WHEN** 档位链用尽且最后一次错误是 429
- **THEN** 仍返回 503 `scope_exhausted`（而非 429 "All models rate-limited"），避免误导客户端退避重试

### Requirement: 精确 model_id pin 行为不变
**Trace**: proposal.md#scoped-model-routing / 向后兼容

请求 `model` 为精确 `model_id`（非 auto、非档位、非 alias）时，系统 SHALL 保持现有行为：该模型设为 `preferredModel` 提到全局活动链队首，failover 池为全局活动链。

#### Scenario: pin 仍走全局 failover
- **WHEN** 请求 `model: "gpt-5"`（某个 model_id，非 alias），该模型失败
- **THEN** failover 到全局活动链的其他模型（与现状一致），不限于某 alias

#### Scenario: pin 不存在的 model_id 仍 400
- **WHEN** 请求 `model: "ghost-model"`（既非 alias 也非任何 model_id）
- **THEN** 返回 400 `model_not_found`（与现状一致）

### Requirement: auto 行为不变
**Trace**: proposal.md#scoped-model-routing / 向后兼容

请求 `model` 为 `auto`/`auto:xxx`/缺省时，系统 SHALL 保持现有 `resolveRoutingChain` 行为，包括全局活动链、global sort、profile 链、sticky session、context handoff。

#### Scenario: auto 全局活动链不变
- **WHEN** 请求 `model: "auto"`
- **THEN** 使用 `getActiveChain()` 全局活动链，failover 跨全部启用模型（与现状一致）

#### Scenario: auto 仍支持 context handoff
- **WHEN** 请求 `model: "auto"` 且 handoff 模式开启
- **THEN** context handoff 正常注入（与现状一致）

### Requirement: 三协议入口统一接入
**Trace**: proposal.md#scoped-model-routing / 三协议入口

`/v1/chat/completions`（proxy.ts）、`/v1/messages`（anthropic.ts）、`/v1/responses`（responses.ts）三个入口 SHALL 共用同一 `resolveRequestedModel` 解析逻辑，对档位/alias 路由行为一致。

#### Scenario: chat 入口支持档位路由
- **WHEN** `POST /v1/chat/completions` body `model: "high-level"`
- **THEN** 走档位展开链 + 组内优先 failover + 用尽报错

#### Scenario: messages 入口支持 alias 路由
- **WHEN** `POST /v1/messages` body `model: "glm5.2"`
- **THEN** 走 alias 展开链 + 组内 failover + 用尽报错

#### Scenario: responses 入口支持档位路由
- **WHEN** `POST /v1/responses` body `model: "middle-level"`
- **THEN** 走档位展开链 + 组内优先 failover + 用尽报错

#### Scenario: 三入口 pin 行为一致
- **WHEN** 三个入口分别请求各自协议格式的 `model: "gpt-5"`
- **THEN** 均走现有 pin 路径（preferredModel + 全局 failover），行为彼此一致且与现状一致

### Requirement: 清理未接线的 strict mode dead code
**Trace**: proposal.md#scoped-model-routing / 清理 dead code

系统 SHALL 移除 commit 65a55ee 引入但从未接线的 `findModelByName` 函数与 `routeRequest` 的 `strictModelId` 参数及其分支。移除 SHALL 不改变任何外部可观察行为（因该参数从未被传入）。

#### Scenario: strictModelId 路径不存在
- **WHEN** 任意请求触发路由
- **THEN** `routeRequest` 不再有 `strictModelId` 形参，`findModelByName` 函数不存在于代码中

#### Scenario: 现有测试全绿
- **WHEN** 移除 dead code 后运行全量测试
- **THEN** 所有现有测试通过（含 proxy-pinned-model / proxy-auto-model / routing-exhaustion）

## SPEC SELF-CHECK

- [x] 每个 Requirement 都能追溯到 proposal 中的 capability 或变更点
- [x] 每个 Requirement 至少包含一个 `#### Scenario:`
- [x] Scenario 描述的是可观察行为，不是内部实现步骤
- [x] MODIFIED Requirements 已完整复制旧 requirement block 后再修改（N/A - 无修改项）
- [x] 未把纯实现重构写成对外行为变化（dead code 清理已注明"不改变外部行为"）
