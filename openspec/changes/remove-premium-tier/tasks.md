# Tasks — Remove Premium Tier

## 0. 执行前判断

**复杂度结论：** 中等需求（删除型，跨 5 文件类别：page/route/middleware-mount/i18n/service-internals + 1 条 migration；不引入新业务规则，仅做反向契约固化）。

**Design 是否存在：** 是（`design.md` 已完成，决策表 §四 锁定 7 个选项）。

**是否允许直接进入任务拆解：** 是。

**Knowledge 是否需要更新：** 否。本次为反向删除；catalog-sync 既有 doc 注释会被改写，不需要外部 knowledge source。

## 0.1 Knowledge 更新任务

- [x] 0.1.1 确认本次 change 受影响的 knowledge 文档（结论：无）
- [x] 0.1.2 在 `proposal.md §6` 已声明无既有 premium/license capability spec，无遗漏

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能（特别：不动签名验证；不动 catalog 拉取节奏；不动 CATALOG_BASE_URL/PUBKEY env；不动 requireAuth 中间件；不动 desktop 端）
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化
- [x] 0.2.3 不修改 design 未覆盖的行为
- [x] 0.2.4 如发现 artifact 与代码事实冲突，先暂停并更新 artifact

---

## 1. 前端：删除 Premium 页面与导航

**关联规格：**
- `catalog-sync / Requirement: catalog-sync 不依赖用户授权`（间接：UI 入口被删除是契约的可观察形态）

**关联设计决策：**
- design §二 局部删除（App.tsx）
- design §3.6 i18n 删除粒度

- [x] 1.1 删除整文件 `client/src/pages/PremiumPage.tsx`
- [x] 1.2 在 `client/src/App.tsx` 删除 line 27 `import PremiumPage`、line 36 nav 项 `{ to:'/premium', labelKey:'nav.premium' }`、line 244 `<Route path="/premium" />`
- [x] 1.3 在 5 个 locale 文件 `client/src/i18n/locales/{en,es,fr,pt-BR,zh-CN}.json` 各自删除：`nav.premium` 单 key、`premium` 顶层块（36 keys）
- [x] 1.4 视觉走查：启动前端，nav 中不再出现"高级版/Premium"项；访问 `/premium` URL 走 App.tsx 现有兜底（NotFound 或空白）
- [x] 1.5 `tsc --noEmit` / `vite build` 通过（确认无残留 PremiumPage 引用）

## 2. 后端：删除 /api/premium 路由

**关联规格：**
- `catalog-sync / Requirement: catalog-sync 不依赖用户授权`

**关联设计决策：**
- design §二 局部删除（app.ts）
- design §3.2 不动 requireAuth

- [x] 2.1 删除整文件 `server/src/routes/premium.ts`
- [x] 2.2 在 `server/src/app.ts` 删除 line 16 `import { premiumRouter }`、line 74 `app.use('/api/premium', requireAuth, premiumRouter)`
- [x] 2.3 服务器启动 `npm run dev` 不报 import 错误
- [x] 2.4 `curl http://localhost:<port>/api/premium` → 404（route 已删，express 兜底）

## 3. 后端：catalog-sync.ts license/tier 解耦

**关联规格：**
- `catalog-sync / Requirement: catalog-sync 不依赖用户授权`（ADDED）
- `catalog-sync / Requirement: getSyncState 不暴露 tier`（ADDED）
- `catalog-sync / Requirement: 启动周期与缓存重放不变`（ADDED）

**关联设计决策：**
- design §二 catalog-sync.ts 大手术
- design §3.1 不删 catalog_applied_version/json
- design §3.4 catalog.tier 容忍但不消费

- [x] 3.1 删除常量 `SETTING_LICENSE_KEY`、`SETTING_LICENSE_STATUS`、`SETTING_APPLIED_TIER`（line 43-44, 46）
- [x] 3.2 删除 `LicenseStatus` interface（line 60-68）
- [x] 3.3 删除 `refreshLicenseStatus()` 函数（line 340-359）与 `getCachedLicenseStatus()` 函数（line 361-369）
- [x] 3.4 在 `syncCatalog()` 内：
  - 删 `const key = getSetting(SETTING_LICENSE_KEY)`（line 271）
  - 删 `if (key) headers.Authorization = ...`（line 275-276）—— `headers` 对象保留为空对象兼容现有 fetch 调用
  - 改 `sameAsApplied`（line 307）只比较 `applied === catalog.version`，去掉 tier 比较
  - 删 `setSetting(SETTING_APPLIED_TIER, catalog.tier)`（line 311）
  - SyncResult 类型与所有 return 语句去掉 `tier` 字段
  - `console.log` 去掉 catalog.tier 字样，改为 `applied v${catalog.version}: ...`
- [x] 3.5 在 `CatalogSyncState` interface 与 `getSyncState()` 中去掉 `appliedTier` 字段
- [x] 3.6 在 `startCatalogSync()` 内 `run` 中删 `void refreshLicenseStatus()`（line 436）
- [x] 3.7 改写顶部 doc 注释（line 7-22）：删去 "Premium / Bearer / live tier" 描述，保留"签名验证 + monthly 节奏 + 不可被 MITM 注入"的说明
- [x] 3.8 `tsc --noEmit` 通过；`npm test -- catalog-sync.test.ts` 全绿

## 4. 后端：清理历史 settings 行 migration

**关联规格：**
- `catalog-sync / Requirement: catalog-sync 不依赖用户授权`

**关联设计决策：**
- design §3.5 settings 清理事务边界

- [x] 4.1 在 `server/src/db/migrations.ts` 新增 `migrateRemovePremiumSettings(db)` 函数：
  ```ts
  function migrateRemovePremiumSettings(db: Database.Database) {
    db.prepare(
      "DELETE FROM settings WHERE key IN ('premium_license_key','premium_license_status','catalog_applied_tier')"
    ).run();
  }
  ```
- [x] 4.2 在 `runMigrations(db)` 末尾调用 `migrateRemovePremiumSettings(db)`
- [x] 4.3 添加 migration test：预置 3 个 license setting 行 → 运行 migration → 这 3 行被删除；其他 settings 保持不变
- [x] 4.4 验证幂等性：在已删除的库上重跑 migration 不报错、不改其他行

## 5. 端到端验证

**关联规格：** 全部本次新增 Requirement

- [x] 5.1 全新部署：启动后端，`curl /api/premium` 404；启动前端，nav 无"高级版"
- [x] 5.2 升级路径：在带 license setting 的旧库启动 → migration 删 3 行；catalog-sync 仍正常 12h 周期跑；不再带 Bearer 头
- [x] 5.3 离线启动：断网启动 → `reapplyCachedCatalog` 仍工作；`getSyncState()` 返回不含 `appliedTier`
- [x] 5.4 自托管 catalog 服务：`CATALOG_BASE_URL` 自定义 → catalog 拉取仍走自定义 URL；签名验证仍走 `CATALOG_PUBKEY`
- [x] 5.5 `npm test` 全绿（特别：catalog-sync.test.ts 不需要改即可通过；migration test 通过）
- [x] 5.6 `tsc --noEmit` 与 `vite build` 全绿

## 6. 文档与 spec 收敛

- [x] 6.1 检查 README.md：搜索 "Premium / 高级 / license" 字样，删除对应章节（若存在）
- [x] 6.2 检查 CONTRIBUTING.md / docs/：同上
- [x] 6.3 archive 时合入新建的 `catalog-sync` 主 spec
- [x] 6.4 git commit 信息中包含本变更的 issue/PR 链接（若有）
