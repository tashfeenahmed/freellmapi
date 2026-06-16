## ADDED Requirements

### Requirement: API 端点导出 API keys
系统 SHALL 提供 `GET /api/keys/export` 端点，解密 `api_keys` 表中所有记录并返回 JSON 数组。

响应 SHALL 为 `Content-Type: application/json`，包含 `Content-Disposition: attachment` 头以便浏览器下载。

JSON 格式 SHALL 为：
```json
{
  "version": 1,
  "exportedAt": "2026-06-16T...",
  "keys": [
    { "platform": "google", "label": "my key", "key": "sk-xxx", "enabled": true, "createdAt": "..." }
  ]
}
```

#### Scenario: 浏览器导出
- **WHEN** 用户在浏览器中访问 `GET /api/keys/export`
- **THEN** 浏览器下载一个 `freellmapi-keys-{date}.json` 文件

#### Scenario: 无 keys 时导出
- **WHEN** 数据库中没有 API keys
- **THEN** 返回空的 keys 数组

### Requirement: CLI 导出 API keys
系统 SHALL 提供 `npm run export-keys` 命令，输出解密后的 API keys JSON 到 stdout。

### Requirement: 前端导出按钮
Keys 页面 SHALL 在页面头部提供一个「导出」按钮，点击后调用 `GET /api/keys/export` 并触发浏览器下载。

## SPEC SELF-CHECK

- [x] 每个 Requirement 能追溯到 proposal
- [x] 每个 Requirement 至少有一个 Scenario
