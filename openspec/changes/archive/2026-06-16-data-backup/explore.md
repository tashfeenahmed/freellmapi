## 1. 输入需求与原始上下文

**原始需求**: 为 freellmapi 添加 API key 配置的备份能力。用户的核心场景是：通过 Docker Compose 运行 freellmapi，希望备份 API key 相关的配置，以便在重新部署或故障恢复后不需要重新申请和配置 API keys。

**目标用户**: freellmapi 的自托管用户（Docker Compose 为主要部署方式）。

**业务背景**: freellmapi 的 API key 相关数据包括两部分：
- `.env` 文件：包含 `ENCRYPTION_KEY`（解密 API keys 的密钥）和其他配置
- SQLite 数据库中的 `api_keys` 表：存储加密后的 provider API keys

没有 `ENCRYPTION_KEY`，已加密的 API keys 无法解密；没有数据库，所有 key 数据丢失。二者缺一不可。

Docker Compose 场景下，`docker-compose.yml` 使用命名卷 `freellmapi-data` 挂载到容器内 `/app/server/data`，宿主机的 `server/data/` 目录为空。

## 2. 业务目标与成功标准

**目标**: 一键备份 API key 相关配置（`.env` + 数据库），在 Docker Compose 和直接运行两种部署模式下均可用。

**成功标准**:
- `npm run backup` 生成包含 `.env` 和数据库的 tar.gz 文件
- Docker Compose 模式下可正确从容器中提取数据库
- 直接运行模式下可正确从 `server/data/` 读取数据库
- `npm run restore -- <file>` 可恢复数据

## 3. 当前工程职责边界

**纳入范围：**
- `.env` 文件备份
- SQLite 数据库备份（自动适配 Docker / 直接运行两种模式）
- 备份和恢复 npm scripts

**不纳入范围：**
- 定时自动备份
- 云存储上传
- benchmarks、analytics 等无关数据的备份

## 4. 现状调研与证据

### 4.1 Docker Compose 配置
```yaml
# docker-compose.yml
volumes:
  - freellmapi-data:/app/server/data   # 数据库在命名卷中
env_file:
  - .env                               # .env 在宿主机上
```

### 4.2 数据位置

| 数据 | 直接运行 | Docker Compose |
|------|---------|----------------|
| `.env` | 宿主机项目根目录 | 宿主机项目根目录 |
| SQLite 数据库 | `server/data/` | Docker 命名卷 `freellmapi-data`，容器内 `/app/server/data` |

### 4.3 提取 Docker 数据的方式
```bash
# docker compose cp 可以将容器内文件复制到宿主机
docker compose cp freellmapi:/app/server/data/. ./backups/
```

## 5. 改动点拆解

### 5.1 必做改动点

1. `scripts/backup.mjs` — 备份脚本，自动检测 Docker/直接运行模式
2. `scripts/restore.mjs` — 恢复脚本
3. `package.json` — 添加 `backup`、`restore` scripts
4. `.gitignore` — 添加 `backups/`

## 6. 追踪关系草案

| 业务目标 | 改动点 | 候选 Capability | 证据 | 状态 |
|---|---|---|---|---|
| 备份 API key 配置 | backup.mjs（双模式支持） | `api-key-backup` | docker-compose.yml | 已确认 |
| 恢复 API key 配置 | restore.mjs | `api-key-restore` | 恢复前需确认覆盖 | 已确认 |

## 7. 风险、未知项与待确认问题

| 风险 | 应对 |
|------|------|
| Docker 服务未运行时备份失败 | 脚本检测并提示用户先启动容器 |

## 8. Knowledge 使用情况

**已参考**: `.gitignore`、`docker-compose.yml`、`docker/README.md`

**是否足够支撑后续阶段**: 是

## 9. Knowledge 缺口与回写预估

无需。

## 10. Capability 候选草案

- `api-key-backup`: 备份 .env + SQLite 数据库（自动适配 Docker/直接运行模式）
- `api-key-restore`: 从备份文件恢复

## 11. 阶段自检

- [x] 已明确纳入范围（API key 配置备份）和不纳入范围
- [x] 已明确 Docker Compose 场景的差异和处理方式
- [x] 每个结论有对应证据
- [x] 未写入具体实现方案
