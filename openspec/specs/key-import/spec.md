# key-import

**Purpose:** 导入 API keys 功能 — 通过 API 端点、CLI 命令和前端按钮，将 JSON 备份文件中的 API keys 加密后写入数据库。

## Requirements

### Requirement: API 端点导入 API keys
系统 SHALL 提供 `POST /api/keys/import` 端点，接收 JSON body，加密后写入 `api_keys` 表。

对于 platform + label 相同的 key，SHALL 执行 UPSERT。

响应 SHALL 返回导入结果：`{ "imported": N, "updated": M, "skipped": K }`。

#### Scenario: 从 JSON 导入
- **WHEN** 客户端 POST JSON 到 `/api/keys/import`
- **THEN** keys 被加密写入数据库，返回导入数量

#### Scenario: 格式错误
- **WHEN** 请求 body 不是有效的 JSON 或缺少 keys 数组
- **THEN** 返回 400 错误

### Requirement: CLI 导入 API keys
系统 SHALL 提供 `npm run import-keys <file>` 命令，读取 JSON 文件并调用导入逻辑。

### Requirement: 前端导入按钮
Keys 页面 SHALL 提供一个「导入」按钮，点击后弹出文件选择器，选择 JSON 文件后 POST 到 `/api/keys/import`，完成后刷新 key 列表。
