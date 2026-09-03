[English](../../../../deployment/02-updates-and-backup.md) · **简体中文**

# 更新与备份

让 Docker 部署保持最新、保护 SQLite 数据卷，并用声明式配置让安装可复现。

- [升级容器](#升级容器)
- [仪表盘更新检查器（#635 / #703）](#仪表盘更新检查器635--703)
- [备份 SQLite 数据卷](#备份-sqlite-数据卷)
- [声明式配置与目录控制项（#f4cd7b4）](#声明式配置与目录控制项f4cd7b4)

## 升级容器

跟踪 `:latest`（或固定到某个发布标签），在新镜像上重建容器：

```bash
docker compose pull && docker compose up -d
```

任何升级都要守住两条不变量：

1. **保持同一个 `.env` 的 `ENCRYPTION_KEY`。** 提供方密钥是静态加密的；换了密钥，所有已存密钥都无法解密。见 [../env/02-security-and-keys.md](../env/02-security-and-keys.md)。
2. **保持同一个数据卷**（`freellmapi-data`，位于 `/app/server/data`）。迁移在每次启动时幂等地执行。

桌面版仪表盘的更新对话框会为 Docker 安装显示这条确切的命令（见下文）。

## 仪表盘更新检查器（#635 / #703）

设置页承载唯一的更新入口：它报告当前运行的版本、列出近期提交，并且——当安装方式是 Docker 时——打印 `docker compose pull && docker compose up -d` 升级命令。相关的控制项：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FREELLMAPI_UPDATE_CHECK` | 启用 | 设为 `off` 可把检查器从设置页隐藏，并阻止 Git 发现和对外发出的更新检查请求。这也会一并关掉自动版本提醒——一个独立的仪表盘设置项（设置 > 通用），在被打开之前始终保持关闭。 |
| `FREELLMAPI_UPDATE_GITHUB_TOKEN` | 空（匿名检查） | 仅用于对 GitHub 做更新检查的可选令牌。只有在需要更高限额时才使用窄权限令牌；通用的 `GITHUB_TOKEN` 值会被有意忽略。 |

两个构建层面的事实支撑着版本显示：`FREELLMAPI_INSTALL_METHOD=docker` 告诉服务器该建议哪条升级路径；runtime 镜像还会复制 `desktop/package.json` ——发布版本号就住在那里，因为 `server/package.json` 跟踪的是工作区版本——作为一个约 400 字节的清单，让容器安装能报出自己的版本（#703）。

## 备份 SQLite 数据卷

要紧的东西都集中在一个地方：命名卷 `freellmapi-data`，挂载于 `/app/server/data`，里面有 SQLite 数据库（`freeapi.db`，或 `FREEAPI_DB_PATH` 指向的位置）、它的 `-wal`/`-shm` 边车文件，以及开发式安装的 `.encryption-key` 文件。把它们作为整体一起备份，并妥善保管配套的 `ENCRYPTION_KEY`——没有它，备份下来的提供方密钥只是无法解密的密文。

内置加密备份（推荐，零停机）。FreeLLMAPI 可以按计划推送活动数据库的加密备份：

```env
FREEAPI_DB_BACKUP_PATH=/app/server/data/freellmapi.db.backup
# 或者：
FREEAPI_DB_BACKUP_URL=https://example.com/freellmapi.db.backup
FREEAPI_DB_BACKUP_TOKEN=optional-bearer-token
FREEAPI_DB_BACKUP_KEY=64-char-hex-backup-key        # 默认取 ENCRYPTION_KEY
FREEAPI_DB_BACKUP_INTERVAL_MS=300000
```

恢复语义：启动时若配置的数据库文件缺失，FreeLLMAPI 会在迁移运行之前恢复备份；服务器运行期间则定期上传新的加密备份。在临时磁盘的主机上，这是主要的保护手段。

卷快照（纯 Docker 做法）。标准模式原样适用：

```bash
docker run --rm -v freellmapi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/freellmapi-data.tar.gz -C /data .
```

由于服务器一直持有数据库（WAL 模式），建议在容器停止时执行（`docker compose stop`），拿到一份静止的拷贝之后再 `docker compose start`。

## 声明式配置与目录控制项（#f4cd7b4）

对需要可复现的 Docker/服务器安装，FreeLLMAPI 可以在每次启动时应用一份 JSON 配置。设置 `FREEAPI_CONFIG_PATH=/path/to/freellmapi.config.json`，或者把同样的 JSON 内联进 `FREEAPI_CONFIG_JSON`。应用过程是幂等的：已有的密钥、自定义提供方、模型编辑、回退行和路由设置都会被更新而不是重复添加，且发生在每次启动的迁移之后。

```json
{
  "keys": [
    { "platform": "groq", "key": "gsk_...", "label": "main" },
    { "platform": "google", "key": "AIza...", "enabled": true }
  ],
  "customProviders": [
    {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "label": "Ollama",
      "models": [
        { "model": "llama3.1:8b", "displayName": "Local Llama", "supportsTools": true }
      ]
    }
  ],
  "models": [
    {
      "platform": "groq",
      "modelId": "llama-3.3-70b-versatile",
      "displayName": "Llama 3.3 70B",
      "supportsTools": true,
      "fallbackEnabled": true
    }
  ],
  "routing": { "strategy": "balanced" }
}
```

如果两个自定义端点提供同一个模型 id，就在 `models` 或 `fallback` 条目里加上 `"endpoint"` 说明你指的是哪一个——端点的 URL，或者仪表盘显示在它旁边的短名。缺省时，匹配到多个端点的条目会被拒绝，而不是随便应用到其中某一个：

```json
{
  "models": [
    { "platform": "custom", "modelId": "deepseek-v3.1", "endpoint": "https://relay-b.example.com/v1", "enabled": false }
  ]
}
```

目录方面：安装会从经过签名的目录订阅源保持模型名册最新（完整目录见 freellmapi.co/models），所以升级之外无需手工维护名册。
