<!-- 注意：以下英文区块标题与标记为 OpenSpec 解析器硬依赖，不能改成中文。正文内容请全部使用中文。 -->

## ADDED Requirements

### Requirement: catalog-sync 不依赖用户授权
Trace: proposal.md#remove-premium-tier / 业务规则 1

`syncCatalog()` 在向上游 catalog 服务发起 HTTP 请求时 MUST NOT 携带任何用户授权信息（包括但不限于 `Authorization` 头、license key bearer、API key、cookie）。所有用户走同一条无授权路径，由上游服务返回任何 catalog（事实上现状是 monthly snapshot），本端按签名验证 + 版本比较 + 应用规则统一处理。系统 MUST NOT 在 settings 表中读取或写入任何 license/license-key/license-status 相关数据。

#### Scenario: catalog 拉取不带 Authorization 头
- **WHEN** `syncCatalog()` 触发对 `${catalogBaseUrl()}/v1/latest` 的 fetch
- **THEN** 请求头 SHALL NOT 包含 `Authorization` 字段，无论 settings 表是否存在任何 license 相关行

#### Scenario: settings 中残留 license 行不影响行为
- **WHEN** 由于历史原因 settings 表中存在 `premium_license_key='xyz'` 行（migration 尚未运行的边界场景）
- **THEN** `syncCatalog()` SHALL NOT 读取该行，请求行为完全不变

#### Scenario: 历史 license 设置自动清理
- **WHEN** 服务启动且 `runMigrations(db)` 运行
- **THEN** settings 表中 `premium_license_key`、`premium_license_status`、`catalog_applied_tier` 三个 key 对应的行 SHALL 被删除（若存在）；migration 重复执行时 MUST NOT 报错

---

### Requirement: getSyncState 不暴露 tier
Trace: proposal.md#remove-premium-tier / 业务规则 2

`getSyncState()` 返回的 `CatalogSyncState` 接口 SHALL NOT 包含 `appliedTier`、`tier`、`license` 任何与付费分层相关的字段。返回结构仅包含：`baseUrl`、`appliedVersion`、`lastSyncMs`、`lastError` 四个字段。`syncCatalog()` 的 `SyncResult` 返回值同样 MUST NOT 包含 tier 字段。

#### Scenario: getSyncState 返回结构
- **WHEN** 客户端代码调用 `getSyncState()`
- **THEN** 返回对象 SHALL 仅包含 `baseUrl: string`、`appliedVersion: string | null`、`lastSyncMs: number | null`、`lastError: string | null` 四个字段

#### Scenario: SyncResult 不含 tier
- **WHEN** `syncCatalog()` 返回成功结果（action 为 `up_to_date` / `applied` / `skipped_older` 任一）
- **THEN** 返回对象 SHALL NOT 包含 `tier` 字段

---

### Requirement: 启动周期与缓存重放不变
Trace: proposal.md#remove-premium-tier / 业务规则 4

`startCatalogSync()` 启动行为 SHALL 保持：① 调用 `reapplyCachedCatalog()` 重放本地缓存；② 在 `BOOT_DELAY_MS` 后首次跑 `syncCatalog()`；③ 之后每 `SYNC_INTERVAL_MS` (12h) 周期跑 `syncCatalog()`。`startCatalogSync()` SHALL NOT 调用任何 license 相关函数（`refreshLicenseStatus` 已被删除）。`CATALOG_SYNC_DISABLED=1` 环境变量的禁用语义不变。

`reapplyCachedCatalog()`、`MIN_CATALOG_VERSION` 校验、签名验证（基于 `CATALOG_PUBKEY` 或内置 `PINNED_CATALOG_PUBKEY`）、`since` 短路、`SETTING_APPLIED_VERSION` / `SETTING_APPLIED_JSON` / `SETTING_LAST_SYNC_MS` / `SETTING_LAST_ERROR` 四个非 license settings 的读写逻辑 MUST 保持原行为不变。

#### Scenario: 启动跑周期 sync 不调 license 函数
- **WHEN** 服务启动且 `CATALOG_SYNC_DISABLED` 未设置
- **THEN** `startCatalogSync()` SHALL 调用 `reapplyCachedCatalog()` 与 `syncCatalog()`；SHALL NOT 调用任何 license/refresh-status 函数

#### Scenario: 离线启动重放本地 catalog
- **WHEN** 服务启动时网络不可达，但 settings 中有 `catalog_applied_json`
- **THEN** `reapplyCachedCatalog()` SHALL 重放该 JSON 到 `models` 表，行为与本变更前一致

#### Scenario: 同版本 catalog 短路
- **WHEN** `syncCatalog()` 拉取的 catalog 版本与 `catalog_applied_version` 相同
- **THEN** 系统 SHALL 跳过 `applyCatalog` 调用，仅更新 `catalog_last_sync_ms`，行为与本变更前一致（区别仅在不再比较 tier）

#### Scenario: CATALOG_SYNC_DISABLED 仍生效
- **WHEN** `CATALOG_SYNC_DISABLED=1` 且服务启动
- **THEN** `startCatalogSync()` SHALL 不启动任何 timer 或调用任何拉取/重放函数
