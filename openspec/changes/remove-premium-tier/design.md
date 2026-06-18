# Design — Remove Premium Tier

## 一. 背景与边界

参见 `proposal.md` §1–§2。本设计只锁定**实施期间的关键决策点**。

## 二. 删除拓扑（哪些是真删、哪些是修改）

```
═══════════════════════════════════════════════════════════════════════════
 整文件删除
═══════════════════════════════════════════════════════════════════════════
  client/src/pages/PremiumPage.tsx                          (264 行)
  server/src/routes/premium.ts                              (127 行)

═══════════════════════════════════════════════════════════════════════════
 局部删除
═══════════════════════════════════════════════════════════════════════════
  client/src/App.tsx
    ├─ line 27   import PremiumPage from '@/pages/PremiumPage'        DELETE
    ├─ line 36   { to: '/premium', labelKey: 'nav.premium' }           DELETE
    └─ line 244  <Route path="/premium" element={<PremiumPage/>} />    DELETE

  server/src/app.ts
    ├─ line 16   import { premiumRouter } from './routes/premium.js'  DELETE
    └─ line 74   app.use('/api/premium', requireAuth, premiumRouter)  DELETE

  client/src/i18n/locales/{en,es,fr,pt-BR,zh-CN}.json
    ├─ "nav": { ..., "premium": ... }                                  DELETE 此 key
    └─ "premium": { ... 36 keys ... }                                  DELETE 整块

═══════════════════════════════════════════════════════════════════════════
 catalog-sync.ts 大手术（按区域列出）
═══════════════════════════════════════════════════════════════════════════
  顶部 doc (line 7-22)        改写：删 "Premium / Bearer / live tier" 字样
  常量 (line 43-44, 46)        删 SETTING_LICENSE_KEY / SETTING_LICENSE_STATUS
                                / SETTING_APPLIED_TIER
  interface LicenseStatus     整块删
  syncCatalog()
    ├─ line 271                 删 const key = getSetting(SETTING_LICENSE_KEY)
    ├─ line 275-276             删 if (key) headers.Authorization = ...
    ├─ line 307                 sameAsApplied 表达式去掉 tier 比较
    ├─ line 311                 删 setSetting(SETTING_APPLIED_TIER, ...)
    ├─ line 304/325/330         返回值去掉 `tier` 字段
    └─ console.log              去掉 catalog.tier
  refreshLicenseStatus()      整函数删
  getCachedLicenseStatus()    整函数删
  CatalogSyncState interface  去掉 appliedTier 字段
  getSyncState()              去掉 appliedTier 字段
  startCatalogSync() run()    删 void refreshLicenseStatus()

═══════════════════════════════════════════════════════════════════════════
 新增（一条 migration）
═══════════════════════════════════════════════════════════════════════════
  server/src/db/migrations.ts
    新函数 migrateRemovePremiumSettings(db):
      DELETE FROM settings WHERE key IN
        ('premium_license_key',
         'premium_license_status',
         'catalog_applied_tier')
    在 runMigrations(db) 中追加调用（位置：所有现有 settings/columns 类
    migration 之后；与功能无依赖，放最后即可）

═══════════════════════════════════════════════════════════════════════════
 测试侧
═══════════════════════════════════════════════════════════════════════════
  server/src/__tests__/services/catalog-sync.test.ts
    现有测试不需改 — 仅引用 applyCatalog/reapplyCachedCatalog/MIN_CATALOG_VERSION
    新增（可选）一条用例：syncCatalog 不发送 Authorization 头
```

## 三. 关键决策点

### 3.1 删 `catalog_applied_version` / `catalog_applied_json` 吗？

**决策：不删。** 这两个 setting 与 license 无关，是 catalog-sync 的核心运行状态：

- `catalog_applied_version` — 用于 `since` 短路（line 278），避免每 12h 重复拉同一版本
- `catalog_applied_json` — 用于离线启动 `reapplyCachedCatalog()` 重放，保证 catalog 在重启间保持一致

删了它们 = 把 catalog-sync 的核心机制砸了。本次范围严格仅删 license 相关的 3 个 key。

### 3.2 删 `requireAuth` 中间件本身吗？

**决策：不删，仅去 `/api/premium` 上的应用。** `requireAuth` 还在保护其他路由（详见 app.ts 用法），与本变更无关。

### 3.3 `/premium` URL 的 fallback 行为

**决策：不专门处理。** App.tsx 的 fallback 路由（如 `<Route path="*" element={<NotFound/>}/>`）会自动接管访问 `/premium` 的浏览器；本变更只删该路由的注册。如果 App.tsx 没有兜底路由，访问该 URL 会渲染空页面 —— 这是 App.tsx 自己的事，不属本范围。

### 3.4 `catalog.tier` 字段在 catalog payload 中是否需要忽略？

**决策：保留容忍。** 上游签名 catalog 的 schema 仍然带 `tier` 字段。本端不再用它做行为分支，但 `isCatalog()` 类型守卫仍可通过（不破坏已存在 catalog）。`syncCatalog()` 返回结果中也不再回填 `tier`（去掉 SyncResult 上的 tier 字段，详见 design §二 syncCatalog 部分）。

### 3.5 删除已有 license 的 settings 行的事务边界

**决策：用独立 migration 在 `runMigrations()` 内执行。** 与重启时跑的其他 migration 同事务/同时机；幂等。

```sql
DELETE FROM settings WHERE key IN (
  'premium_license_key',
  'premium_license_status',
  'catalog_applied_tier'
);
```

不需要任何并发协调 —— migration 在 `startCatalogSync()` 之前已跑完。

### 3.6 i18n 删除是 key-by-key 还是整块删

**决策：删整块 + 删 nav.premium 单 key**。每个 locale 文件结构稳定（顶层有固定数量的 capability 块），删除 `premium` 这个顶层 key 与 `nav.premium` 这个嵌套 key 即可，其他不动。

### 3.7 spec 该归入哪个 capability？

**决策：新建 `catalog-sync` capability spec。** 当前 `openspec/specs/` 没有 catalog-sync 的对应 capability spec。本变更顺手把"catalog-sync 不依赖授权"这层契约固化下来。这是必要的，因为它是删除事物时的关键反向不变量 —— 没有它，将来有人补回 Bearer 逻辑就没人挡。

## 四. 决策表

| # | 选项空间 | 决定 | 收益 |
|---|---|---|---|
| 1 | catalog_applied_version / json 是否删 | 不删 | 保住 catalog-sync 核心运行机制 |
| 2 | requireAuth 中间件是否删 | 不删 | 仍保护其他路由 |
| 3 | catalog.tier 上游字段如何处理 | 容忍但不消费 | 不破坏现有 signed catalog payload |
| 4 | settings 清理方式 | migration 内 DELETE，幂等 | 与项目所有 migration 一致风格 |
| 5 | i18n 删除粒度 | 删 premium 顶层块 + nav.premium 单 key | 最小变动面 |
| 6 | spec 归属 | 新建 catalog-sync capability spec | 反向不变量固化，防回流 |
| 7 | /premium URL fallback | 不专门处理（App.tsx 自己 NotFound） | 不扩大本变更面 |

## 五. 不做的事

- 不重命名 catalog-sync 内任何残留概念（`appliedVersion`、`appliedJson`、`MIN_CATALOG_VERSION` 等保持原名）
- 不动签名验证流程任何细节
- 不动 `CATALOG_BASE_URL` / `CATALOG_PUBKEY` / `CATALOG_SYNC_DISABLED` 三个 env 的语义
- 不删除 desktop 端的 Premium 入口（如有，本次范围外，单独 issue）
- 不动 README、CONTRIBUTING、LICENSE（除非 README 中存在显式 "Premium" 章节，由 task 步骤判断）
- 不引入 feature flag —— 这是不可逆删除，回滚通过 git revert 即可
