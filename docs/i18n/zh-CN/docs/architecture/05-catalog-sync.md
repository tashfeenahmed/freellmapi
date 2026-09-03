[English](../../../../architecture/05-catalog-sync.md) · **简体中文**

# 目录同步 —— 深度剖析

> **源码：** `server/src/services/catalog-sync.ts`、`server/src/services/model-state.ts`、`server/src/db/migrations/`

## 1. 概览

目录同步把本地模型目录与 `freellmapi.co` 的发布目录保持同步。它**每天两次**（及按需）跑、抓取**签名目录**、对**钉死的 Ed25519 公钥**验签、并**事务性**应用到本地 SQLite。

### 两层

| 层 | 受众 | 刷新节奏 | 认证 |
|------|----------|-----------------|------|
| **Live** | 付费授权持有者 | 2–3 天 | Bearer `premium_license_key` |
| **Monthly** | 免费安装 | ~30 天 | 无（公开） |

免费安装仍能自愈，只是节奏慢。**打包迁移仍是基线**——抓到的目录只有在**比 `MIN_CATALOG_VERSION` 新**（每次模型迁移都会推这个版本）时才应用，所以陈旧的月度快照永远回滚不了更新版本加进来的模型。

---

## 2. 目录结构

```typescript
interface Catalog {
  version: string;           // 如 "2026.06.07"
  generatedAt: string;       // ISO 时间戳
  tier: 'live' | 'monthly';
  models: CatalogModel[];    // 聊天模型
  embeddings?: CatalogEmbedding[];       // 可选，合并新鲜度源
  transcriptionModels?: CatalogTranscriptionModel[]; // STT，独立顶层键
  quirks: CatalogQuirk[];    // 运维建议
}
```

### CatalogModel（聊天）

| 字段 | 用途 |
|-------|---------|
| `platform`, `modelId` | 主键（中继模型含 `endpoint_scope`） |
| `displayName` | UI 名称 |
| `intelligenceRank` | 1..1000（1 = 最强），提供方内部 |
| `speedRank` | 1..11（目录手分，1 = 最快） |
| `sizeLabel` | `Frontier` \| `Large` \| `Medium` \| `Small`（跨提供方层级） |
| `limits` | `{rpm, rpd, tpm, tpd}` —— 按模型上限 |
| `monthlyTokenBudget` | 字符串标签（如 `"1M"`、`"2x"`）供余量护栏 |
| `contextWindow` | 最大上下文（词元） |
| `enabled` | 目录级启用（false 则强制禁用） |
| `supportsVision` / `supportsTools` | 能力标记 |
| `modality` | `'text'`（默认）→ `models` 表；`'image'`/`'audio'` → `media_models` |
| `mediaNote` | 媒体模型的短显示文案 |
| `requestStyle` | 适配器风格（如 Cloudflare 图像：`'json'` \| `'multipart'`） |

### 生成式媒体 & 语音识别

- **媒体模型**（`modality: 'image' | 'audio'`）→ `media_models` 表，受 `MEDIA_PLATFORMS` 集合门控。
- **语音识别模型** → `media_models` 且 `modality = 'transcription'`，受 `TRANSCRIPTION_PLATFORMS` 门控。
- 独立顶层键（`transcriptionModels`、`embeddings`），让旧二进制忽略未知模态、不把它们误路由成聊天模型。

---

## 3. 签名验证

```typescript
const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----`;

// 抓取
const res = await fetch(`${catalogBaseUrl()}/v1/latest`, { headers: { Authorization: `Bearer ${key}` } });
const signature = res.headers.get('x-catalog-signature');
const bytes = Buffer.from(await res.arrayBuffer());
const verified = crypto.verify(null, bytes, catalogPublicKey(), Buffer.from(signature, 'base64'));
```

- **钉死公钥**：私钥半边从未离开目录主机。
- **自托管目录覆盖**：`CATALOG_BASE_URL`、`CATALOG_PUBKEY` 环境变量。
- **防篡改**：未签名或被改的直接丢弃。被攻陷的 CDN / MITM 无法注入模型或 quirks。

---

## 4. 应用规则（用户数据保护）

在**单个事务**里应用（`applyCatalog`）：

| 规则 | 行为 |
|------|---------|
| 元数据（名、秩、限额、上下文、能力） | 跟目录走，**除非**用户有显式本地覆盖 |
| `enabled: false` | **强制禁用**（模型上游已死） |
| `enabled: true` | **永不重启用**用户关掉的模型 |
| 用户建行（`source = 'user'`） | **永不更新、永不删除、永不收养** —— `platform:model_id` 撞车时用户行胜、目录条目跳过 |
| 用户删过的目录模型 | 经**墓碑**（`catalog_model_tombstones` 表）保持删除 |
| 自动退役（410/寿终） | **禁用、不删** —— 目录里再出现 enabled 就解除退役（#634） |
| 目录里消失的模型 | **删除**（先 fallback_config、FK 顺序） |

### 来源列（`source`）

替代旧 `size_label NOT IN ('User','Custom')` 启发式。取值：

- `'catalog'` —— 目录同步建的
- `'user'` —— 声明式配置、管理员添加、自定义端点
- `'declarative'` —— 来自声明式配置文件

---

## 5. 同步流程

```
syncCatalog(force=false)
  ├─ GET /v1/latest?since=<appliedVersion>（有授权则带 Bearer）
  ├─ 304 → up_to_date
  ├─ 验签（Ed25519）
  ├─ 解析 + 结构校验 (isCatalog)
  ├─ version < MIN_CATALOG_VERSION? → skipped_older（会回滚迁移）
  ├─ 同版本+同层已应用? → up_to_date
  ├─ applyCatalog(db, catalog) → 事务性 upsert/insert/delete
  ├─ 持久化设置：appliedVersion、appliedTier、appliedJSON（已验证文档）
  └─ 记数：updated、inserted、removed、skippedUnknownPlatform、quirks
```

### 启动重应用 (`reapplyCachedCatalog`)

迁移每次启动都跑、重断言打包基线（目录可能删了的基线模型 `INSERT OR IGNORE`）。启动时网络同步若版本没变会 304，**不**重应用。没有这一步，每次重启都会把数据库往基线方向漂、直到下一次目录版本推进。

```
reapplyCachedCatalog()
  ├─ 读 SETTING_APPLIED_JSON（缓存的已验证文档）
  ├─ 校验 + version ≥ MIN_CATALOG_VERSION
  ├─ applyCatalog(db, parsed) → 同步、无网络
  └─ 记录："re-applied cached live v2026.06.07 after boot"
```

- 旧版升级：有 applied-version 但无缓存文档的安装 → 清 applied version → 下轮轮询抓全量目录。

---

## 6. 模型年龄闸（30 天）

`generatedAt` 起算超 30 天的模型从 **Live 层排除**（免费层拖尾快照）。目录服务端强制；客户端只收到该层提供的东西。

---

## 7. 授权状态

```typescript
interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  checkedAtMs: number;
}
```

- 缓存在设置里（`premium_license_status`），每次同步刷新。
- 权利**服务端**在 `/v1/latest` 强制——本地缓存只是 UI 用的信息态。
- 离线/服务挂了 → 保留缓存状态。

---

## 8. Quirks（运维建议）

```typescript
interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}
```

- 纯内容：**每次同步整体替换**（DELETE + INSERT）。
- 仪表盘为受影响模型展示 blocker/warning。

---

## 9. 设置键

| 键 | 用途 |
|-----|---------|
| `premium_license_key` | Live 层用的 Bearer 令牌 |
| `premium_license_status` | 缓存的 `LicenseStatus` JSON |
| `catalog_applied_version` | 最后应用的目录版本 |
| `catalog_applied_tier` | `'live'` \| `'monthly'` |
| `catalog_applied_json` | 已验证目录文档（供启动重应用） |
| `catalog_last_sync_ms` | 最后成功同步的时间戳 |
| `catalog_last_error` | 最后同步错误消息 |

---

## 10. 调度器集成

```typescript
startCatalogSync(scheduler: Scheduler)
  ├─ reapplyCachedCatalog()  // 同步、无网络
  ├─ scheduler.after(10s, run)  // 启动延迟
  └─ scheduler.every(12h, run)  // 每天两次
```

- `run()` = `refreshLicenseStatus()` + `syncCatalog()`
- 熔断开关：`CATALOG_SYNC_DISABLED=1`

---

## 11. 迁移播种 vs 托管目录

| 方面 | 打包迁移 | 托管目录同步 |
|--------|-------------------|---------------------|
| **权威** | 基线地板 | 实时事实来源 |
| **版本** | `MIN_CATALOG_VERSION`（日期） | `catalog.version`（日期） |
| **新模型** | 迁移 PR 加 | 下次目录发布出现 |
| **限额修正** | 迁移 PR | 从提供方错误学 + 目录更新 |
| **退役** | 迁移（禁用 + 墓碑） | 目录 `enabled: false` → 强制禁用 |
| **中继模型** | 不在目录 | 仅自定义端点（用户行） |
| **回滚保护** | N/A | `version < MIN_CATALOG_VERSION` → 跳过 |

### 自定义模型 / 中继模型

- **永不**来自目录。通过下列创建：
  - `POST /api/media/custom`（生成式媒体 / STT）
  - `POST /api/custom-endpoint`（聊天中继）
  - 声明式配置文件
- 绑定到携带其端点的 `api_keys` 行（`models` 行上 `key_id`）。
- `endpoint_scope = 'custom:<base_url_hash>'` 区分服务同一 `model_id` 的中继。
- 目录同步**跳过** `platform = 'custom'` 和未知平台（旧二进制）。

---

## 12. 关键函数

| 函数 | 用途 |
|----------|---------|
| `syncCatalog(force?)` | 抓 → 验签 → 应用（或 304/跳过） |
| `applyCatalog(db, catalog)` | 事务性 upsert/insert/delete + quirks |
| `reapplyCachedCatalog()` | 启动时从已验证缓存重应用 |
| `refreshLicenseStatus()` | 对目录服务校验授权 |
| `getSyncState()` | 仪表盘状态面板 |
| `startCatalogSync(scheduler)` | 注册 12h 间隔 + 启动延迟 |
| `isCatalog(value)` | 结构校验（畸形 body 大声报错） |
| `routableContextWindow(platform, modelId, cw)` | GitHub gpt-4.1 覆盖（8000） |

---

## 13. 涉及表

| 表 | 操作 |
|-------|-----------|
| `models` | UPSERT 聊天模型（catalog 来源） |
| `media_models` | UPSERT 图像/音频/语音识别 |
| `embedding_models` | UPSERT 嵌入（全量快照） |
| `fallback_config` | 保证每个模型有行 |
| `catalog_model_tombstones` | 尊重用户删除 |
| `quirks` + `quirk_targets` | 整体替换 |
| `settings` | 持久化 applied version/tier/json、授权状态、同步时间 |

---

## 14. 环境变量

| 变量 | 默认值 | 用途 |
|----------|---------|---------|
| `CATALOG_BASE_URL` | `https://api.freellmapi.co` | 目录服务端点 |
| `CATALOG_PUBKEY` | 钉死 Ed25519 公钥 | 自托管目录覆盖 |
| `CATALOG_SYNC_DISABLED` | `0` | 熔断开关（`1` = 禁用） |

---

## 15. 错误处理

| 场景 | 行为 |
|----------|----------|
| 网络超时 (20s) | 记警告、保留上一版目录 |
| HTTP 304 | `up_to_date`、更新 `last_sync_ms` |
| HTTP 非 2xx | 错误、保留上一版目录 |
| 缺签名 | 丢弃、报错 |
| 签名验证**失败** | 丢弃、**大声报错** —— "catalog signature verification FAILED — discarding response" |
| 无效 JSON / 结构 | 丢弃、报错 |
| 版本老于基线 | `skipped_older`、等更新版目录 |
| 应用时 DB 不可用 | 事务回滚、报错、保留上一状态 |
| 授权检查不可达 | 保留缓存状态、同步仍跑（层由服务端定） |