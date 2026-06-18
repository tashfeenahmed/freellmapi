## 1. 需求摘要

**问题：** 项目当前承载完整一套 "Premium 高级版" license 体系：前端 `PremiumPage` UI、后端 `/api/premium` 路由、`catalog-sync` 服务中的 License Bearer 认证与 `live`/`monthly` tier 切换、5 套语言共 180+ 翻译条目、3 个相关 settings 键 (`premium_license_key` / `premium_license_status` / `catalog_applied_tier`)。维护方已决定不再保留付费分层，希望项目回归"所有人吃同一份 catalog"的纯净形态。

**机会：** Catalog 拉取/签名验证/应用/缓存复用流程与 license 完全解耦 —— `syncCatalog()` 内部 license 仅决定是否在请求头加 `Authorization: Bearer`，无 license 时上游返回 free/monthly tier 仍是合法路径。删除 license 相关分支后，catalog-sync 仍 100% 工作，所有用户得到 monthly 节奏的 catalog，与现状的 free 用户路径一致。

**为什么现在做：** 留着死路径是持续的认知开销（新人看到 `appliedTier`、`license` 概念会困惑「免费版到底跑哪条路」），且每次改 catalog-sync 都要兼顾两条 tier；趁未对外公布过付费方案，一次性拆干净比迭代式拆更安全。

## 2. 当前工程范围与边界

**纳入范围：**

前端：
- 删除 `client/src/pages/PremiumPage.tsx`（264 行）
- `client/src/App.tsx` 删除：line 27 import、line 36 nav 项 `{ to:'/premium', labelKey:'nav.premium' }`、line 244 `<Route path="/premium" />`
- 5 个 locale 文件 (`en/es/fr/pt-BR/zh-CN.json`) 删除 `nav.premium` 与整个 `premium.*` 翻译块

后端 routes：
- 删除 `server/src/routes/premium.ts`（127 行）
- `server/src/app.ts` 删除：line 16 import、line 74 `/api/premium` 挂载

后端 catalog-sync 解耦（`server/src/services/catalog-sync.ts`）：
- 删除 `SETTING_LICENSE_KEY` / `SETTING_LICENSE_STATUS` / `SETTING_APPLIED_TIER` 三个常量及其所有读写
- 删除 `LicenseStatus` interface
- 删除 `refreshLicenseStatus()` / `getCachedLicenseStatus()` 两个 export
- `syncCatalog()` 移除 Bearer 认证头注入逻辑（line 271, 276）
- `syncCatalog()` 移除写 `SETTING_APPLIED_TIER` 的语句（line 307, 311）以及 sameAsApplied 比较中的 tier 维度
- `getSyncState()` 与 `CatalogSyncState` interface 移除 `appliedTier` 字段
- `startCatalogSync()` 内部 `run()` 移除 `void refreshLicenseStatus()` 调用
- 顶部模块 doc 注释（line 7-22）改写：删去对 Premium / Bearer / live tier 的描述，保留签名验证 + monthly 节奏的说明

后端数据迁移：
- 新增 migration `migrateRemovePremiumSettings`：`DELETE FROM settings WHERE key IN ('premium_license_key','premium_license_status','catalog_applied_tier')`，幂等

测试：
- 跑 `server/src/__tests__/services/catalog-sync.test.ts` 现有测试全绿（这些测试仅依赖 applyCatalog/reapplyCachedCatalog/MIN_CATALOG_VERSION，不引用 license 体系，零回归风险）
- 删除任何专测 license/premium 路径的测试文件（如有）

文档：
- README 中提到 Premium 的章节按本次提交方向调整或删除（具体由 design 锁定）

**不纳入范围：**
- 改造 catalog-sync 的拉取节奏（仍 12h 一次）
- 改造签名验证 / `MIN_CATALOG_VERSION` 校验 / cached catalog 重新应用逻辑
- 改 `CATALOG_BASE_URL` / `CATALOG_PUBKEY` 环境变量（自托管路径不动）
- 改其他设置键 `catalog_applied_version` / `catalog_applied_json` / `catalog_last_sync_ms` / `catalog_last_error`（这些与 license 无关，属 catalog-sync 公共状态）
- 改 `requireAuth` 中间件本身（仅删除其在 `/api/premium` 上的应用）
- 数据库 settings 表 schema（仅删行，不删表）
- 改 desktop 客户端（如果有独立 Premium 入口由本任务额外清理；否则不动）

## 3. 业务语义拆解

**业务对象：** 无新增。被移除的对象：`License`（key + 校验状态）、`Catalog Tier`（live vs monthly 的区分）、`Premium Page`（UI）。

**业务规则变更：**

1. **所有用户走同一条 catalog 拉取路径** — 不再有 Bearer 头注入；上游 `/v1/latest` 接收无认证请求并返回（事实上已就是的）monthly snapshot；签名验证、版本比较、应用、缓存重放、错误记录全部保持原样。
2. **`getSyncState()` 不再暴露 tier** — 由于已无 tier 概念，返回结构去掉 `appliedTier` 字段；上游消费者（仅前端原 PremiumPage 一处，已删）不存在了。
3. **历史 license setting 行清理** — 已激活的 license 行不再有用；通过启动 migration 删除 `premium_license_key` / `premium_license_status` / `catalog_applied_tier` 三个 settings 行（幂等）。
4. **catalog-sync 启动行为不变** — `startCatalogSync` 仍然 boot-delay → reapplyCachedCatalog → syncCatalog 周期循环；仅去掉 `refreshLicenseStatus()` 一行调用。

**关键场景：**
- (S1) 升级用户曾经激活过 license → migration 自动删 license setting；下次 sync 不再带 Bearer；上游返回 monthly snapshot；用户无感知（catalog 仍按 12h 周期同步）
- (S2) 自托管 catalog 服务的用户 → `CATALOG_BASE_URL` env 仍生效，行为不变
- (S3) 离线启动 → `reapplyCachedCatalog` 仍重放本地缓存（与 license 无关）
- (S4) 已部署但从未激活 license 的用户 → 行为完全不变，只是少了一个 UI 入口
- (S5) 任何用户访问 `/premium` URL → React Router 显示 "Not Found" 或退回 home（视 App.tsx 路由 fallback 定义）

## 4. 技术语义映射

| 业务概念 | 技术语义 | 对应模块或入口 | 备注 |
|---|---|---|---|
| 删除前端 Premium 页面 | 删文件 + 路由 + 导航项 | `client/src/pages/PremiumPage.tsx` (整文件); `App.tsx` line 27/36/244 | nav 数组顺序保持稳定，不动其他项 |
| 删除前端 i18n | 删 `nav.premium` 与 `premium.*` 块 | 5 × `client/src/i18n/locales/*.json` | 5 语言一致处理 |
| 删除后端 Premium API | 删文件 + 路由挂载 | `server/src/routes/premium.ts` (整文件); `app.ts` line 16/74 | 不动 `requireAuth` 本身 |
| 解耦 catalog-sync license | 删常量/接口/函数/分支 | `server/src/services/catalog-sync.ts` | 见 §2 详细行号 |
| 历史 settings 清理 | 新 migration 删 3 个 key | `server/src/db/migrations.ts` 新增 `migrateRemovePremiumSettings` | 幂等：`DELETE FROM settings WHERE key IN (...)` |
| 启动 sync 的 license 调用 | 删 `void refreshLicenseStatus()` | `server/src/services/catalog-sync.ts:436` | 仅一行 |
| 文档同步 | 改 `catalog-sync.ts` 顶部 doc 注释 | line 7-22 | 删 "Premium / Bearer / live tier" 字样，保留签名 + monthly 描述 |

## 5. 变更清单

**删除：**
- 整文件：`client/src/pages/PremiumPage.tsx`、`server/src/routes/premium.ts`
- App.tsx 中 3 处（import / nav 项 / Route）
- app.ts 中 2 处（import / 挂载）
- 5 个 locale 文件中各 1 个 `nav.premium` + 1 个 `premium.*` 块
- catalog-sync.ts 中 license/tier 相关常量、接口、函数、分支（详见 §2）

**新增：**
- 一条 migration `migrateRemovePremiumSettings`（清理 3 个 settings key）
- 修改两份 spec deltas（见 §6）

**修改：**
- `catalog-sync.ts` 顶部 doc 注释（删 Premium 描述）
- `catalog-sync.ts` `CatalogSyncState` interface（去 `appliedTier`）
- `catalog-sync.ts` `getSyncState()`（去 `appliedTier`）
- `catalog-sync.ts` `syncCatalog()`（去 Bearer / 去 tier 写入 / 去 tier 比较）
- `catalog-sync.ts` `startCatalogSync()`（去 `refreshLicenseStatus()` 调用）

## 6. 受影响的 capability spec

| Capability | 增减 |
|---|---|
| 新建 `catalog-sync` capability spec | ADDED 三条 Requirement：catalog-sync 不依赖用户授权信息；getSyncState 返回结构不含 tier；启动周期与缓存重放语义不变 |
| 现有 spec | （`openspec/specs/` 中没有 premium/license 相关 capability spec 存在，无 REMOVED 项） |

注：当前 `openspec/specs/` 中没有 `premium` 或 `license` 命名的 capability spec —— 这套体系从未被正式 spec 化，所以 spec 删除面比想象的小。本次主要是**通过 ADDED Requirement 锁定"无 license"形态的 catalog-sync 行为契约**，让未来 PR 不会无意中再引入 Bearer 路径。
