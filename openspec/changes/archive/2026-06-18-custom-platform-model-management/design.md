# Design — Custom Platform Model Management

## 一. 背景与边界

参见 `proposal.md` §1–§2。本设计仅锁定**实施期间的关键决策点**，不重复 proposal 已有的范围声明。

## 二. 数据流（端到端）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            场景 A — 创建 custom key                         │
└─────────────────────────────────────────────────────────────────────────────┘

UI: CustomProviderSection (KeysPage)
  POST /api/keys/custom
    body { baseUrl, models[], displayName?, apiKey?, label? }
        │
        ▼
keys.ts handler (现有)
  ┌─ INSERT api_keys (platform='custom', base_url=baseUrl, encrypted_key=…)
  ├─ for entry in models:
  │     scopedModelId = `${keyId}-${entry.modelId}`
  │     INSERT models (platform='custom', model_id=scopedModelId,
  │                    key_id=keyId, source='user',  ← 新增
  │                    enabled=1, …)
  │     ON CONFLICT(platform, model_id) DO UPDATE SET
  │            display_name=excluded.display_name,
  │            key_id=excluded.key_id,
  │            enabled=1
  │     INSERT fallback_config (model_db_id, priority=MAX+1, enabled=1)
  └─ return { keyId, models: registered[] }

┌─────────────────────────────────────────────────────────────────────────────┐
│                  场景 B — 用户在 Drawer 顶部添加模型（默认全选）            │
└─────────────────────────────────────────────────────────────────────────────┘

UI: ManageModelsDrawer (kind='customEndpoint', baseUrl=X, keys=[k11, k12])
  AddCustomModelDialog 默认勾选 [k11, k12]
  POST /api/models
    body { keyIds: [11, 12], modelId: "qwen3:8b", displayName: "Qwen3 8B" }
        │
        ▼
models.ts POST handler (修改)
  if body.keyIds is non-empty array:
    校验：所有 keyId 都属于 platform='custom' 的 api_keys 行
    校验：所有 keyId 共享同一 base_url（防跨端点写入）  ← 决策见 §四
    db.transaction(() => {
      created = []
      updated = []
      for keyId in keyIds:
        scopedModelId = `${keyId}-${modelId}`
        existing = SELECT id FROM models WHERE platform='custom' AND model_id=scopedModelId
        if existing:
          UPDATE models SET display_name=? WHERE id=existing.id
          updated.push(existing.id)
        else:
          INSERT models (..., source='user', enabled=1)
          INSERT fallback_config (model_db_id=newId, priority=MAX+1, enabled=1)
          created.push(newId)
    })
    return 200 { created, updated }
  else (旧路径):
    body { platform, modelId, ... }   ← 现有 user-managed-models 行为，不变

┌─────────────────────────────────────────────────────────────────────────────┐
│              场景 C — 用户在 key section 内禁用 / 删除一个模型             │
└─────────────────────────────────────────────────────────────────────────────┘

PATCH /api/models/:id  body { enabled: false }    ← 已支持，无改动
DELETE /api/models/:id                            ← 已支持，source='user' 才允许硬删
                                                    custom 行天然 source='user' ✓
```

## 三. 数据结构变更

### 3.1 Schema

**无新列、无新表。** `models.source` 列已由 `user-managed-models` 引入。

### 3.2 Migration

新增 migration（命名暂定 `migrateCustomModelsSourceUser`），在 `models.source` 列引入之后运行，幂等：

```sql
UPDATE models
SET source = 'user'
WHERE platform = 'custom' AND source != 'user';
```

**幂等性论据：** 后续 `POST /custom` 与 `POST /api/models` 的 custom 写入路径都直接写 `source='user'`，所以重启再跑此 migration 不会产生差异；catalog-sync 不会触碰 `platform='custom'` 行（`applyCatalog` 处理的是 catalog 中列出的非 custom platform）；本 migration 不会跟 user-managed-models 主 migration 互相覆盖。

**置入位置：** 紧跟 `runMigrations()` 中现有 `migrateModelsSourceColumn`（或同等命名）之后。

## 四. 关键决策点

### 4.1 跨端点写入校验

**问题：** `POST /api/models` body 接受 `keyIds[]` 时，是否要求所有 keyId 共享同一 base_url？

**选项：**
- **A. 严格校验** — 服务端拒绝跨 base_url 的 keyIds 组合（返回 400）
- **B. 不校验** — 任意 custom keyIds 都可批量写入

**决策：A。** 理由：
1. 现实中没有"把一个模型同时写入两个不同 endpoint 的 keys"的合理场景（不同 endpoint 的 model 名空间独立、能力不同）；
2. UI 上"添加模型"对话框只暴露同一 base_url 下的 keys，前端永远不会构造跨 base_url 的 keyIds，B 选项的额外灵活性是 0；
3. 若用户用 curl 手动构造跨 endpoint 请求，A 能给出明确错误；B 会静默成功但产生奇怪数据。

**实现：** handler 内
```ts
const rows = db.prepare(
  `SELECT id, base_url FROM api_keys WHERE id IN (${keyIds.join(',')}) AND platform='custom'`
).all();
if (rows.length !== keyIds.length) → 400 "some keyIds invalid"
const baseUrls = new Set(rows.map(r => r.base_url));
if (baseUrls.size > 1) → 400 "keyIds span multiple base_urls"
```

### 4.2 UPDATE-on-conflict 范围

**问题：** 命中已存在行时，UPDATE 哪些字段？

**决策：仅 `display_name`。** 理由：
1. 用户答案明确选择"方案 c"（已存在的当 UPDATE，覆盖 displayName）；
2. `enabled` 不能覆盖 — 用户可能在 Drawer 上禁用了某 key 的某 model，添加路径不该把它复活（与 user-managed-models 的"不复活用户禁用"原则一致）；
3. `key_id` 由 `scopedModelId` 唯一确定，永不需要改；
4. `source` 已是 'user'，不需改；
5. `intelligence_rank / speed_rank / size_label / *_limit / monthly_token_budget / context_window / supports_*` —— custom 模型这些字段一律走默认值，没有 UPDATE 的语义。

**实现：** 单条 SQL：
```sql
INSERT INTO models (platform, model_id, key_id, display_name, source, enabled,
                    intelligence_rank, speed_rank, size_label, ...)
VALUES ('custom', ?, ?, ?, 'user', 1, 50, 50, 'User', ...)
ON CONFLICT(platform, model_id) DO UPDATE SET
  display_name = excluded.display_name
RETURNING id, (xmax = 0) AS is_insert;
```
（better-sqlite3 没有 `RETURNING` 跨方言保证；落地时改为 `SELECT id FROM models WHERE platform=? AND model_id=?` 在 INSERT 前后比对，或用 `db.prepare(...).run()` 的 `changes` 字段判断 INSERT vs UPDATE。）

### 4.3 添加模型对话框：单组件还是按入口分两组件？

**决策：单组件 `AddCustomModelDialog`，通过 `defaultSelectedKeyIds` prop 控制初始勾选。**

```
顶部入口：<AddCustomModelDialog
  keys={endpoint.keys}
  defaultSelectedKeyIds={endpoint.keys.map(k => k.id)}  // 全选
/>

key section 入口：<AddCustomModelDialog
  keys={endpoint.keys}
  defaultSelectedKeyIds={[currentKey.id]}              // 仅勾自己
/>
```

理由：两个入口的提交逻辑、字段集合完全相同，差异只在初始勾选 → 一个 prop 解决，无须双组件。

### 4.4 KeysPage 渲染顺序

**决策：** `[...PLATFORMS, ...customEndpointGroups]`，custom endpoint groups 在所有非 custom platform 之后，按 `base_url` 字母序排列。

**特例：** 当用户还没有任何 custom key 时，仍要让 `CustomProviderSection`（创建表单）渲染 —— 它当前挂在 `CUSTOM_GROUP` 内。落地方案：把 `CustomProviderSection` 提取出 group 循环，独立渲染在所有 group 之下（与 customEndpointGroups 平级），永远显示。

### 4.5 ManageModelsDrawer props 重构

**当前：** `<ManageModelsDrawer open onClose platform platformLabel />`

**改造为：**
```ts
type ManageModelsDrawerProps =
  | { open: true; onClose: () => void; kind: 'platform'; platform: Platform; platformLabel: string }
  | { open: true; onClose: () => void; kind: 'customEndpoint'; baseUrl: string; keys: ApiKey[] }
  | { open: false; onClose: () => void };
```

**调用侧：**
```tsx
const [drawerState, setDrawerState] = useState<DrawerState>({ kind: null });
// 普通 platform：setDrawerState({ kind: 'platform', platform: 'groq', ...})
// custom endpoint：setDrawerState({ kind: 'customEndpoint', baseUrl: 'http://...', keys: [...]})
```

**理由：** 联合类型让两种模式的不变量显式（platform 模式没有 keys，customEndpoint 模式没有 platform 字段），TypeScript 帮我们避免传错。

## 五. 校验与错误码

| 场景 | 状态码 | message |
|---|---|---|
| `keyIds` 为空数组 | 400 | "keyIds must be non-empty for custom platform" |
| `keyIds` 含未知 id | 400 | "keyIds contains invalid ids: …" |
| `keyIds` 含非 custom 平台的 id | 400 | "keyIds must all belong to platform='custom'" |
| `keyIds` 跨 base_url | 400 | "keyIds span multiple base_urls" |
| `modelId` 缺失或长度 > 200 | 400 | (沿用现有 user-managed-models 校验) |
| `modelId` 含特殊前缀冲突 | n/a | scopedModelId 只在内部构造，用户输入永远是 raw modelId |

## 六. 决策表

| # | 选项空间 | 决定 | 简化收益 |
|---|---|---|---|
| 1 | custom 是否后端建模为独立 platform | 否，纯前端聚合 | 不动 router/catalog/fallback；接触面 5 文件 |
| 2 | 跨 base_url 多 key 写入是否允许 | 否，严格校验 | 防止用户/脚本误用；UI 永远不会触发 |
| 3 | 已存在行的 UPDATE 范围 | 仅 display_name | 不与"不复活用户禁用"冲突 |
| 4 | "添加模型"入口 | 顶部 + 每 key section（双入口）| 顶部默认全选 = 批量铺设；section 默认仅自己 = 精确扩展 |
| 5 | Drawer 列表分段维度 | 按 key_id 分段 | 与 models.key_id 数据事实一致 |
| 6 | source 三分体系是否覆盖 custom | 是，custom 一律 user | PATCH/DELETE 既有逻辑无差别复用 |
| 7 | 历史 custom 行是否回填 source | 是，幂等 migration | 升级用户立即获得 PATCH/DELETE 能力 |
| 8 | `CustomProviderSection`（创建表单）位置 | 提到 group 循环外，永远显示 | 用户即使没有任何 custom key 也能看到表单 |

## 七. 不做的事

- **per-key model allowlist 的精细化** — 当前 `models.key_id` 已经实现了"该 key 才认这些 model"，无需额外配置；
- **"复制模型到另一个 key" 快捷操作** — 用户可以先添加到目标 key 即可，无需专门 UI；
- **"导入 OpenAI-compatible 端点的 /v1/models 列表"自动发现** — 对话框仍是手动输入 modelId（保持简单）；
- **endpoint 级别的元数据**（label、备注）—— 当前 `api_keys.label` 在 key 维度已可表达，endpoint 级别用 base_url 字符串作为唯一标识即可。
