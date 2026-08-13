#!/bin/bash
# deploy.sh — 打包 FreeLLMAPI 部署产物到 deploy/freellmapi-YYYYMMDD.zip
#
# 流程:
#   1. 构建服务端 (server/dist) 与客户端 (client/dist)
#   2. 组装部署目录 deploy/freellmapi-YYYYMMDD/
#   3. 备份当前 SQLite 数据库到 data/backup_full.sql
#   4. 打包为 deploy/freellmapi-YYYYMMDD.zip
#
# 打包内容与 deploy/freellmapi-20260709/ 结构保持一致:
#   .env.example  package.json  server/(package.json + dist)  shared/
#   client/dist   scripts/(setup.sh, import-data.sh)  data/backup_full.sql

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DATE=$(date +"%Y%m%d")
PKG="freellmapi-${DATE}"
STAGING="./deploy/${PKG}"
ZIP="./deploy/${PKG}.zip"

# ---------------------------------------------------------
# 1. 构建
# ---------------------------------------------------------
echo -e "${YELLOW}[1/4] 构建服务端与客户端...${NC}"
npm run build -w server
npm run build -w client
echo -e "${GREEN}✓ 构建完成${NC}"

# ---------------------------------------------------------
# 2. 组装部署目录
# ---------------------------------------------------------
echo -e "${YELLOW}[2/4] 组装部署目录 ${STAGING} ...${NC}"
rm -rf "$STAGING"
mkdir -p "$STAGING/server" "$STAGING/client" "$STAGING/shared" "$STAGING/scripts" "$STAGING/data"

cp .env.example "$STAGING/.env.example"
cp package.json "$STAGING/package.json"

# 将本地的 ENCRYPTION_KEY 带入部署包: API Key 用该 key 加密存储, 若生产环境
# 用不同 key, 已加密的提供方密钥将无法解密(表现为"密钥丢失")。
LOCAL_ENV_KEY=""
if [ -f .env ]; then
    LOCAL_ENV_KEY="$(sed -n 's/^ENCRYPTION_KEY=//p' .env | head -1 | tr -d '[:space:]' | sed 's/^"//;s/"$//')"
fi
if [ -z "$LOCAL_ENV_KEY" ] && [ -f server/data/.encryption-key ]; then
    LOCAL_ENV_KEY="$(tr -d '[:space:]' < server/data/.encryption-key)"
fi
if [ -n "$LOCAL_ENV_KEY" ] && [ "$LOCAL_ENV_KEY" != "your-64-char-hex-key-here" ]; then
    if [[ "$(uname)" == "Darwin" ]]; then
        sed -i '' "s/your-64-char-hex-key-here/$LOCAL_ENV_KEY/" "$STAGING/.env.example"
    else
        sed -i "s/your-64-char-hex-key-here/$LOCAL_ENV_KEY/" "$STAGING/.env.example"
    fi
    echo -e "${GREEN}✓ 已将本地 ENCRYPTION_KEY 写入部署包 .env.example${NC}"
else
    echo -e "${YELLOW}⚠ 未找到本地 ENCRYPTION_KEY, 生产环境将生成新 key, 已加密的 API Key 将无法解密!${NC}"
fi

cp server/package.json "$STAGING/server/package.json"
cp -R server/dist "$STAGING/server/dist"

cp -R client/dist "$STAGING/client/dist"

cp shared/package.json "$STAGING/shared/package.json"
cp shared/types.ts "$STAGING/shared/types.ts"

cp deploy-scripts/setup.sh "$STAGING/scripts/setup.sh"
cp deploy-scripts/import-data.sh "$STAGING/scripts/import-data.sh"
chmod +x "$STAGING/scripts/"*.sh

# 排除非必须的开发文件: source map、TypeScript 类型声明、.DS_Store
find "$STAGING" \( -name "*.map" -o -name "*.d.ts" -o -name ".DS_Store" \) -delete

echo -e "${GREEN}✓ 部署目录组装完成${NC}"

# ---------------------------------------------------------
# 3. 备份当前数据库
# ---------------------------------------------------------
echo -e "${YELLOW}[3/4] 备份当前 SQLite 数据库...${NC}"

DB_PATH="${FREEAPI_DB_PATH:-$ROOT/server/data/freeapi.db}"
if [ ! -f "$DB_PATH" ]; then
    echo -e "${RED}错误: 未找到数据库文件 ${DB_PATH}${NC}"
    exit 1
fi

BACKUP_FILE="$STAGING/data/backup_full.sql"

if command -v sqlite3 &>/dev/null; then
    sqlite3 "$DB_PATH" ".dump" > "$BACKUP_FILE"
else
    echo -e "${RED}错误: 未找到 sqlite3 CLI, 无法备份数据库 (apt install sqlite3 / brew install sqlite3)${NC}"
    exit 1
fi

if [ ! -s "$BACKUP_FILE" ]; then
    echo -e "${RED}错误: 数据库备份为空: ${BACKUP_FILE}${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 数据库备份完成: ${BACKUP_FILE}${NC}"

# ---------------------------------------------------------
# 4. 打包 (直接打包目录内容, 解压后即为部署文件, 不含外层目录)
# ---------------------------------------------------------
echo -e "${YELLOW}[4/4] 打包 ${ZIP} ...${NC}"
rm -f "$ZIP"
(
    cd "$STAGING"
    COPYFILE_DISABLE=1 zip -r -q "../${PKG}.zip" .
)

if [ $? -ne 0 ]; then
    echo -e "${RED}打包失败${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 打包完成: ${ZIP}${NC}"
echo -e "${GREEN}  部署包内容:${NC}"
zipinfo -1 "$ZIP" | sed 's/^/    /'
