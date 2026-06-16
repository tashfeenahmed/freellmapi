## 0. 执行前判断

**复杂度结论：** 简单需求

**Design 是否存在：** 否（proposal + specs 足够指导实现）

**是否允许直接进入任务拆解：** 是

**Knowledge 是否需要更新：** 否

**说明：** 两个改动点各自独立、改动量小（~30行），不涉及 schema 迁移、接口变更或新协议。

## 0.1 Knowledge 更新任务

无需更新。

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不实现 tasks.md 未明确声明的功能
- [x] 0.2.2 不做无关重构、顺手优化、无关格式化或批量改名
- [x] 0.2.3 不修改 proposal/specs/design 未覆盖的行为
- [x] 0.2.4 如发现 artifact 与代码事实冲突，先暂停并更新 artifact，再继续实施
- [x] 0.2.5 不动前端代码（KeysPage 无需修改）
- [x] 0.2.6 不动数据库 schema

## 1. Custom 平台多 key 支持

**关联规格：**
- custom-key-management: 同 base_url 多 key
- custom-key-management: 不同 key 注册同名 model 不冲突
- custom-key-management: 删除仅影响自身绑定的 model

**涉及文件或模块：**
- `server/src/routes/keys.ts` — POST /custom 和 DELETE /:id

**验收方式：**
- 手工验证：同 base_url 创建两个不同 key，确认两个都存在于 key 列表
- 手工验证：两个 key 各注册同名 model `test-model`，确认 models 表有两行
- 手工验证：删除一个 key 后，另一个 key 的 model 仍可正常路由

**回滚方式：**
- `git revert` 本次 commit

- [x] 1.1 在 `server/src/routes/keys.ts` POST /custom 处理中，移除 `SELECT ... WHERE base_url = ?` 查找和 UPDATE 分支，改为始终 INSERT 新 key 行
- [x] 1.2 在 `server/src/routes/keys.ts` POST /custom 的 model 注册 INSERT 中，将 `model_id` 改为 `keyId + '-' + modelId` 格式，确保不同 key 的同名 model 在 `UNIQUE(platform, model_id)` 下不冲突
- [x] 1.3 在 `server/src/routes/keys.ts` DELETE /:id 处理中，确认 `DELETE FROM models WHERE platform = 'custom' AND key_id = ?` 级联逻辑不受影响（仅验证，无需改动）
- [ ] 1.4 手工验证：创建两个同名 custom key 下的 model，确认 fallback_config 和路由均正常

## 2. 月度预算按 key 数量缩放

**关联规格：**
- token-budget: 月度令牌预算按启用 key 数量缩放
- token-budget: key 数量变更后 budget 随之更新

**涉及文件或模块：**
- `server/src/services/router.ts` — `orderChain` / `scoreChainEntry` 中的 budget 计算

**验收方式：**
- 运行 `server/src/__tests__/services/router.test.ts`（如存在相关测试）
- 手工验证：3 个 key 时 headroom 计算使用 3× budget

**回滚方式：**
- `git revert` 本次 commit

- [x] 2.1 在 `server/src/services/router.ts` 的 `orderChain`（或 `scoreChainEntry` 调用前）中，对 sorted chain 按 platform 分组查询启用 key 数量，构建 `Map<string, number>`（platform → key count）
- [x] 2.2 修改 `scoreChainEntry` 签名或调用处，将 `parseBudget(entry.monthly_token_budget)` 的结果乘以该 platform 的 key count
- [x] 2.3 确认 custom 平台的 key 计数逻辑：custom model 的 budget 不乘以平台 key 数（每个 custom model 只绑定一个 key），保持 budget 不变或乘以 1
- [ ] 2.4 手工验证：添加 3 个 Google key，通过日志或调试确认 `gemini-2.5-flash` 的 budget 被缩放为 9M（3x 3M）

## 99. 最终自检

- [x] 所有任务都能追溯到 requirement 或 proposal 中的变更点
- [x] 每个任务都有明确验收方式
- [x] 未包含无关重构、顺手优化或未授权范围
- [x] 已列出必要测试、验证和回滚任务
- [x] 如果存在开放问题，已标记为阻塞或非阻塞
