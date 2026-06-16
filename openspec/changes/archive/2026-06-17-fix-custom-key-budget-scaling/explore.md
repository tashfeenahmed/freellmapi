## 1. 输入需求与原始上下文

**原始需求（用户反馈）：**

1. **Custom 平台不支持同 baseURL 多 key** — 当前 `POST /api/keys/custom` 对相同 `base_url` 做去重（upsert），用户无法像其他平台（google、openrouter 等）一样为一个自定义端点配置多个 API key。用户期望和其他平台行为一致：一个 base_url 下可以存在多个 key。

2. **每月令牌额度未按 key 数量缩放** — 模型的 `monthly_token_budget`（如 `~12M`）是每个 key 独立的免费配额。当前系统的预算计算是模型级别的，不感知 key 数量。例如 3 个 Google key 各 12M/mo，实际可用 36M，但系统只按 12M 计算 headroom，导致过早限流。

**需求来源：** 项目主开发者  
**目标用户：** Free LLM API 的所有用户（对免费 API key 有管理需求的开发者）

## 2. 业务目标与成功标准

**为什么做：**
- 自定义端点场景中，用户可能持有同一服务商的多个 key（如不同的 Ollama Cloud 账号、不同权限级别的 token），当前限制导致第二个 key 添加失败（覆盖第一个）
- 多个 key 叠加使用是免费 API 聚合工具的核心价值——用多个免费配额拼出一个稳定的服务
- 当前预算不随 key 缩放会导致"明明还有多个 key 的配额，系统却认为配额耗尽"的假阳性

**成功标准：**
- 同一 base_url 下可以添加多个 custom key，互不覆盖
- 删除一个 custom key 时不影响该 base_url 下其他 key
- 每月令牌预算 = 模型的基础 budget × 该模型/平台下启用的 key 数量
- headroom 保护逻辑基于缩放后的预算工作，不再过早触发

## 3. 当前工程职责边界

**纳入范围：**
- `POST /api/keys/custom` 的 key 创建逻辑（去除 base_url 去重）
- `server/src/services/router.ts` 中 headroom 计算的 budget 缩放
- `server/src/services/scoring.ts` 中 `headroomFactor` 使用的 key 数量感知
- 自定义 key 删除时正确级联（不误删同 base_url 的兄弟 key）

**不纳入范围：**
- 前端 UI 大改（KeysPage 已有基础的 key 列表展示，custom key 新增只需后端支持）
- 非 custom 平台的 key 唯一性（它们本来就没有唯一性限制）
- 模型 `monthly_token_budget` 字段的存储位置变更（保持放在 models 表，不做 schema 迁移）

## 4. 现状调研与证据

### 4.1 现有模块与入口

**Custom key 创建：** `server/src/routes/keys.ts:183-201`

```typescript
// base_url 去重逻辑
const existing = db.prepare(
  "SELECT id FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1"
).get(baseUrl) as { id: number } | undefined;

if (existing) {
  // 更新已有行（覆盖 key）
  const { encrypted, iv, authTag } = encrypt(rawKey);
  db.prepare("UPDATE api_keys SET label = ?, encrypted_key = ?, ... WHERE id = ?")
    .run(label, encrypted, iv, authTag, existing.id);
  keyId = existing.id;
} else {
  // 插入新行
  const { encrypted, iv, authTag } = encrypt(rawKey);
  const r = db.prepare(`INSERT INTO api_keys (...) VALUES (...)`)
    .run(label, encrypted, iv, authTag, baseUrl);
  keyId = Number(r.lastInsertRowid);
}
```

**对比非 custom 平台：** `server/src/routes/keys.ts:65-119` — `POST /api/keys` 对 google/openrouter 等**没有任何唯一性限制**，每次都是 `INSERT`（除 keyless provider 有 sentinel 去重外）。

**Custom 模型注册与 key 绑定：** `server/src/routes/keys.ts:209-216`
```typescript
db.prepare(`
  INSERT INTO models
    (platform, model_id, display_name, ..., key_id)
  VALUES ('custom', ?, ?, ..., ?)
  ON CONFLICT(platform, model_id)
  DO UPDATE SET display_name = excluded.display_name, key_id = excluded.key_id, enabled = 1
`).run(modelId, displayName, keyId);
```
`models` 表有 `UNIQUE(platform, model_id)` 约束。custom model 的 `model_id` 是用户输入的名字（如 `qwen3:4b`）。如果两个 key 注册同名的 model，ON CONFLICT 会覆盖旧行的 key_id——导致旧 key 的 model 失去绑定。

**Custom key 绑定：** `server/src/services/router.ts:631`
```typescript
// Custom model 绑定到特定的 api_keys 行（key_id）
if (entry.platform === 'custom' && entry.key_id != null && key.id !== entry.key_id) continue;
```
这是正确的一对多关系：一个 model 行通过 `key_id` 绑定到特定的 custom key 行。

**月度预算计算：** `server/src/services/scoring.ts:124-130`
```typescript
export function headroomFactor(usedTokens: number, budgetTokens: number): number {
  if (!budgetTokens || budgetTokens <= 0) return 1;
  const remaining = Math.max(0, 1 - usedTokens / budgetTokens);
  if (remaining >= HEADROOM_RAMP_START) return 1;
  return HEADROOM_FLOOR + (1 - HEADROOM_FLOOR) * (remaining / HEADROOM_RAMP_START);
}
```

**预算传入路径：** `server/src/services/router.ts:347-348`
```typescript
const budget = parseBudget(entry.monthly_token_budget);
const headroom = headroomFactor(stats?.monthlyUsedTokens ?? 0, budget);
```
- `budget` 来自 `models.monthly_token_budget` 字段（模型级别，不变）
- `monthlyUsedTokens` 来自 `refreshStatsCache → requests` 表，按 `(platform, model_id)` 聚合

**月度使用量聚合：** `server/src/services/router.ts:273-281`
```sql
SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
FROM requests
WHERE created_at >= datetime('now', 'start of month') AND request_type = 'chat'
GROUP BY platform, model_id
```
没有 `key_id` 的分组——所有 key 的用量被合并。

**Custom key 删除级联：** `server/src/routes/keys.ts:265-280`
```typescript
if (row.platform === 'custom') {
  db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
  db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
  if (remaining.n === 0) {
    // 清理所有残留的 legacy custom model 行
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
  }
}
```
这段逻辑依赖 `key_id` 精确绑定到正确的 key 行。去重修复后不需要改动（已经按 `key_id` 级联）。

### 4.2 上下游与依赖

```
POST /api/keys/custom
  ├── api_keys 表（key 存储）
  ├── models 表（注册 custom model，绑定 key_id via ON CONFLICT）
  └── fallback_config 表（追加到链路）

routeRequest()
  ├── getActiveChain() → models JOIN fallback_config
  ├── orderChain() → scoring.ts（bandit 评分）
  │   └── headroomFactor(monthlyUsedTokens, budget)
  └── key 选择 → round-robin + key_id 绑定（custom 跳过非匹配 key）

DELETE /api/keys/:id
  ├── 删除 api_keys 行
  └── 级联删除 models WHERE key_id = ?（仅 platform='custom'）
```

### 4.3 现有行为与约束

- `api_keys` 表无 `(platform, base_url)` SQL 级别 UNIQUE 约束——去重是应用层做的
- `models` 表有 `UNIQUE(platform, model_id)` 约束
- custom key 删除时依赖 `key_id` 级联正确删除对应 model 行
- `monthly_token_budget` 是 models 表的列——一个模型行存一个预算值

## 5. 改动点拆解

### 5.1 必做改动点

**A. 去除 custom key 的 base_url 去重**
- 文件：`server/src/routes/keys.ts:183-201`
- 改动：移除 `SELECT ... WHERE base_url = ?` 查找和 UPDATE 分支，每次直接 INSERT
- 影响范围：仅 custom 平台，无数据库 schema 变更

**B. custom model 的 model_id 去重处理**
- 问题：去掉 key 去重后，两个不同 key 可能注册同名 model（如都注册 `qwen3:4b`），`ON CONFLICT(platform, model_id) DO UPDATE` 会导致旧 model 行的 `key_id` 被覆盖
- 方案：将 custom model 的 model_id 改为 `{keyId}-{modelId}` 格式，确保不同 key 注册的同名 model 拥有独立的 model 行
- 文件：`server/src/routes/keys.ts:209-216`

**C. 月度预算按 key 数量缩放**
- 文件：`server/src/services/router.ts:347-348`（或通过 `scoreChainEntry` 的 `ChainRow` 携带 key count）
- 改动：`budget` 值乘以该平台/模型下启用的 key 数量
- 需要在 `orderChain` 或 `scoreChainEntry` 调用处注入 key 计数信息
- 文件：`server/src/services/router.ts:323-353`（`scoreChainEntry` 签名可能需加 `keyCount` 参数）

**D. 删除级联验证**
- 文件：`server/src/routes/keys.ts:265-280`
- 确认按 `key_id` 级联删除逻辑在去重修复后仍正确工作（已验证现有逻辑依赖 `key_id`，不依赖 base_url）

### 5.2 可选 / 后续改动点

- 前端显示"当前 key 数量 × 每 key 预算 = 总预算"
- 支持 per-key 自定义 budget 覆盖

## 6. 追踪关系草案

| 业务目标 | 改动点 | 候选 Capability | 证据 | 状态 |
|---|---|---|---|---|
| 同 baseURL 多 key | A. 去除 base_url 去重 | custom-key-management | keys.ts:183-201 | 已确认 |
| model_id 不冲突 | B. model_id 唯一性处理 | custom-key-management | models UNIQUE(platform, model_id) | 已确认 |
| 预算按 key 缩放 | C. budget × keyCount | token-budget-scaling | router.ts:347-348, scoring.ts:124 | 已确认 |
| 删除不影响兄弟 key | D. 级联删除验证 | custom-key-management | keys.ts:265-280 | 已确认 |

## 7. 风险、未知项与待确认问题

**风险：**
- 改动 B 涉及 model_id 命名策略变更，已有 custom model 不受影响（只改新增的）
- 如果用户有大量 key（10+），模型预算会等比例放大，headroom 保护可能不触发
- model_id 用 `{keyId}-{name}` 格式会使前端显示的模型名包含数字前缀

**待确认：**
- 预算缩放用"平台下启用的 key 数"还是"该模型绑定的 key 数"？对于 built-in 平台（google 等），一个 key 服务所有模型→用平台级别 key 数。对于 custom 平台，每个 model 绑定一个 key→用 key_id 数。

## 8. Knowledge 使用情况

**Knowledge 证据记录：**
- Source: `server/src/routes/keys.ts:183-201` — Evidence: base_url upsert 逻辑
- Source: `server/src/routes/keys.ts:65-119` — Evidence: 非 custom 平台无去重
- Source: `server/src/routes/keys.ts:209-216` — Evidence: ON CONFLICT(platform, model_id)
- Source: `server/src/services/router.ts:347-348` — Evidence: budget 从 models 表读取
- Source: `server/src/services/router.ts:273-281` — Evidence: 月度用量按 (platform, model_id) 聚合
- Source: `server/src/services/scoring.ts:124-130` — Evidence: headroomFactor 不感知 key 数
- Source: `server/src/db/migrations.ts:59-76` — Evidence: models UNIQUE(platform, model_id)
- Source: `server/src/routes/keys.ts:265-280` — Evidence: key_id 级联删除

**当前是否足够支撑后续阶段：** 是

## 9. Knowledge 缺口与回写预估

无需。

## 10. Capability 候选草案

### 新增 Capabilities
- 无新增，属于现有功能的修正

### 修改 Capabilities
- **custom-key-management**: custom 平台支持同 base_url 多 key
- **token-budget**: 每月令牌预算按启用 key 数量缩放

## 11. 阶段自检

- [x] 已明确本工程纳入范围和不纳入范围
- [x] 每个关键结论都有证据或标记为推断
- [x] 已列出进入 proposal 前必须确认的问题
- [x] 已给出业务目标到 capability 候选的追踪关系
- [x] 未写入具体实现方案或代码级任务
