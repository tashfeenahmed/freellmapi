## 0. 执行前判断

**复杂度结论：**
简单需求（keys 模块内的增量添加）

**Design 是否存在：**
否

**是否允许直接进入任务拆解：**
是

**说明：**
三个层面：API 端点（复用已有 crypto 模块）、前端按钮（文件下载/上传）、CLI 脚本（同 API 逻辑）。

## 0.1 Knowledge 更新任务

- [x] 0.1.1 无 knowledge 影响

## 0.2 禁止事项与范围锁定

- [x] 0.2.1 不修改 crypto.ts 等业务代码
- [x] 0.2.2 不搞定时备份、不上传云端
- [x] 0.2.3 不改变现有 key 增删改逻辑

## 1. API 端点 — 导出

**关联规格：** `key-export` / API 端点导出

**涉及文件：** `server/src/routes/keys.ts`

**验收方式：** `curl /api/keys/export` 返回 JSON

- [x] 1.1 在 `keysRouter` 添加 `GET /export` 路由
- [x] 1.2 查询所有 api_keys，逐行 decrypt
- [x] 1.3 返回 JSON `{ version, exportedAt, keys: [...] }`
- [x] 1.4 设置 `Content-Disposition: attachment; filename="freellmapi-keys-{date}.json"`

## 2. API 端点 — 导入

**关联规格：** `key-import` / API 端点导入

**涉及文件：** `server/src/routes/keys.ts`

**验收方式：** `curl -X POST /api/keys/import -d @keys.json` 成功写入

- [x] 2.1 在 `keysRouter` 添加 `POST /import` 路由
- [x] 2.2 验证 JSON body（zod schema）
- [x] 2.3 逐行 encrypt → UPSERT 到 api_keys（按 platform + label）
- [x] 2.4 返回 `{ imported, updated }`

## 3. CLI 脚本

**关联规格：** `key-export` / `key-import` CLI 需求

**涉及文件：** `scripts/export-keys.ts`、`scripts/import-keys.ts`（新建）

- [x] 3.1 `export-keys.ts`：调用 API 或直接操作 DB，输出 JSON 到 stdout
- [x] 3.2 `import-keys.ts <file>`：读取 JSON，调用 API 或直接操作 DB
- [x] 3.3 注册 npm scripts：`"export-keys"`、`"import-keys"`

## 4. 前端 — 导出/导入按钮

**关联规格：** `key-export` / `key-import` 前端需求

**涉及文件：** `client/src/pages/KeysPage.tsx`

- [x] 4.1 在 PageHeader actions 区域添加「导出」按钮，调用 `/api/keys/export` 下载文件
- [x] 4.2 添加「导入」按钮，通过隐藏的 `<input type="file">` 选择文件，POST 到 `/api/keys/import`
- [x] 4.3 导入完成后刷新 keys 列表（invalidateQueries）

## 5. 端到端验证

- [x] 5.1 前端导出 → 下载 JSON → 检查内容
- [x] 5.2 前端导入 → 上传 JSON → 确认 key 恢复
- [x] 5.3 CLI 导出：`npm run export-keys`
- [x] 5.4 CLI 导入：`npm run import-keys -- keys-backup.json`

## 99. 最终自检

- [x] 所有任务可追溯到 requirement
- [x] 每个任务有验收方式
- [x] 未包含无关改动
