## 1. 需求摘要

用户希望导出加密存储在 SQLite 中的 API keys 为明文 JSON，便于备份和迁移。同时希望在前端 Keys 管理页面上直接操作，无需命令行。

本 change 提供 CLI 脚本 + API 端点 + 前端 UI 三个层面的导入/导出能力。

## 2. 当前工程范围与边界

**纳入范围：**
- `GET /api/keys/export` — 解密所有 keys，返回 JSON
- `POST /api/keys/import` — 接收 JSON，加密后写入数据库
- Keys 页面新增「导出」「导入」按钮
- `npm run export-keys` / `npm run import-keys` CLI 脚本
- Docker Compose 和直接运行两种模式

**不纳入范围：**
- 备份 `.env`、analytics 等其他数据
- 定时备份、云存储

## 3. 业务语义拆解

| 业务对象 | 规则 | 场景 |
|---|---|---|
| **导出** | 解密所有 api_keys → JSON | 前端按钮下载 / CLI stdout |
| **导入** | 读 JSON → 加密 → UPSERT | 前端上传文件 / CLI 读文件 |

## 4. 技术语义映射

| 层面 | 导出 | 导入 |
|------|------|------|
| API | `GET /api/keys/export` → JSON response | `POST /api/keys/import` body 为 JSON |
| CLI | `tsx scripts/export-keys.ts` → stdout | `tsx scripts/import-keys.ts <file>` |
| 前端 | Keys 页面「导出」按钮 → 下载 .json | Keys 页面「导入」按钮 → 文件上传 |

## 5. 变更清单

1. 新增 API 端点：`GET /api/keys/export`、`POST /api/keys/import`
2. 新增 CLI 脚本：`scripts/export-keys.ts`、`scripts/import-keys.ts`
3. 修改前端：KeysPage 添加导出/导入按钮
4. 修改 `package.json`：添加 npm scripts

## 6. 追踪关系

| 业务目标 | 变更点 | Capability | 验收口径 |
|---|---|---|---|
| 导出 keys | API + CLI + 前端按钮 | `key-export` | JSON 中包含解密后的 key |
| 导入 keys | API + CLI + 前端按钮 | `key-import` | keys 正确恢复到数据库 |

## 7. Capabilities

### 新增 Capabilities
- `key-export`: 解密并导出 API keys 为 JSON（API + CLI + UI）
- `key-import`: 从 JSON 导入 API keys（API + CLI + UI）

## 8. 复杂度判定

**复杂度结论：** 简单需求（changes 范围是 keys 模块内的增量添加）

## 9-12. （略，同前）
