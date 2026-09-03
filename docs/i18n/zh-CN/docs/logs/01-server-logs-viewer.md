[English](../../../../logs/01-server-logs-viewer.md) · **简体中文**

# 服务器日志查看器

仪表盘内置实时 **服务器日志** 查看器（从分析导航菜单进入），它把服务器打印到 stdout 的同那些诊断行——路由决策、提供方健康检查、密钥冷却、额度耗尽、压缩保真度闸门、以及任何 `warn`/`error` 级别事件——呈现在面前，无需 SSH 或容器日志访问。

---

## 双层存储

日志存储在两个层级使用**同一 id 空间**：

| 层级 | 容量 | 级别 | 持久化 | 用途 |
| --- | --- | --- | --- | --- |
| **环形缓冲区** | 1,000 条（最新） | `trace`、`debug`、`info`、`warn`、`error` | 仅内存 | 轮询仪表盘的实时尾部；经得起过滤器变更，经不住重启。 |
| **`server_logs` 表** | 可配置（`SERVER_LOGS_MAX_ROWS`，默认 50,000） | 仅 `warn`、`error` | SQLite（重启保留） | 对最重要的警告/错误的持久历史。 |

- **Id 由存储分配**，不是 SQLite。启动时计数器从 `MAX(id)` 种子，所以 id 跨重启单调递增。拿着 `sinceId` 游标的仪表盘标签页永远不会见到它倒退。
- 启动时存储**预加载至多 200 条最近持久化行**（最新优先）进环形缓冲，这样仪表盘显示的是重启前的警告，而不是空面板。
- 采集发生在**脱敏包装器内部**（`lib/log-redaction.ts`）。进程里只有一个 console 补丁；它先脱敏，然后存储只看到已脱敏的形式。机密永不进入环形缓冲或数据库。
- 匹配 `GET|HEAD /api/(logs|ping)` 的行在入口处被过滤掉，防止自喂缓冲（轮询端点原本会成为日志里最吵的东西）。

---

## API 契约

所有端点挂在 `/api/logs` 下，受仪表盘会话门控保护（统一 `/v1` 密钥打开推理面，**绝不**打开这个——这些行会泄露提供方、模型、密钥 id、失败原因）。

### `GET /api/logs` —— 轮询端点

面向每隔几秒轮询一次的仪表盘的基于游标分页。

| 查询参数 | 类型 | 说明 |
| --- | --- | --- |
| `sinceId` | `integer`（可选） | 返回比这个 id **更新**的条目。省略则取最新 `limit` 条（默认 200）。返回的 `nextId` 游标是存储的最高 id，**不是**返回的最高 id——所以匹配全被过滤掉的一次轮询仍能推进游标，而不是永远重扫同一段尾部。 |
| `levels` | `csv`（可选） | 逗号分隔的级别过滤：`trace,debug,info,warn,error`。未知级别返回 `400`。 |
| `q` | `string`（可选） | 跨 `message`、`provider`、`source`、`event` 的大小写不敏感文本搜索。 |
| `provider` | `string`（可选） | 精确提供方名过滤（如 `openai`、`anthropic`）。 |
| `limit` | `integer`（可选） | 钳制在 `[1, 500]`，默认 `200`。 |

**响应：**

```json
{
  "entries": [
    {
      "id": 12345,
      "ts": "2026-08-23T14:32:11.123Z",
      "level": "warn",
      "source": "CooldownProbe",
      "provider": "openai",
      "model": "gpt-4o",
      "event": "cooldown_triggered",
      "requestId": "req_abc123",
      "message": "[CooldownProbe] openai:gpt-4o key #3 entered 45s cooldown (rate limit)"
    }
  ],
  "nextId": 12345,
  "counts": { "debug": 12, "info": 145, "warn": 8, "error": 2 }
}
```

- `trace` 在计数里并入 `debug`（仪表盘显示四个徽章）。
- `entries` 数组在返回页内是 **最旧 → 最新**。
- 已追上来的调用者（`sinceId >= lastId`）只需一次整数比较就拿到 `entries: []`。

### `GET /api/logs/counts` —— 级别计数

返回每次轮询响应里都带的同一个 `LogLevelCounts` 对象，所以只想要徽章数字的页面能一次性取走，不用拉完整条目载荷。

```json
{ "debug": 12, "info": 145, "warn": 8, "error": 2 }
```

### `POST /api/logs/clear` —— 清空两层

清空环形缓冲区**并**截断 `server_logs` 表。id 计数器**不重置**——不然拿着游标的仪表盘标签页会收到它已经见过的 id。

```json
{ "ok": true }
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SERVER_LOGS_RETENTION_DAYS` | `7` | 超过这么多天的行会被每日维护任务删除（见 `server/src/jobs/prune-logs.ts`）。 |
| `SERVER_LOGS_MAX_ROWS` | `50000` | `server_logs` 表的硬上限。超限时下一次插入会删最旧的行。 |

两者启动时读取；改它们要重启。

---

## 脱敏集成

存储是 `lib/log-redaction.ts` **内部的一个抽头**，不是第二层 console 包装器。流向：

1. 应用代码调用 `console.log` / `providerLog()` / 等。
2. 脱敏包装器拦截，擦除机密（API 密钥、Bearer 令牌、URL 令牌等），把干净行发给**原始** stdout。
3. 包装器**然后**调用 `recordConsoleLine()` / 存储收到已脱敏文本。
4. `providerLog()`（用于结构化运维事件）在记录前自己脱敏消息，再镜像给包装过的 console——二次通过也是幂等的。

结果：**机密永不进入环形缓冲区或数据库**，运维看到的仪表盘行跟终端里看到的完全一样。

---

## 客户端实现注记 (`client/src/pages/LogsPage.tsx`)

- **轮询间隔：** 3 秒（`LOG_POLL_MS`），标签页后台时暂停（`refetchIntervalInBackground: false`）。
- **过滤器变更**（级别复选框、提供方下拉、搜索框）重置流：缓冲清空、游标置空、新查询键 → 全新的最新 200 页。
- **搜索防抖：** 300 ms（`SEARCH_DEBOUNCE_MS`）。
- **跟随尾部：** 只有用户停在底部（40 px 内）时才自动滚动。向上滚动即分离；分离期间有新行到来会出现「跳到最新」药丸。
- **条目缓冲：** 组件状态里封顶 500 条（`LOG_BUFFER_LIMIT`）；新页到来时最旧逐出。
- **可展开行：** 超过 300 字符的消息被钳制并带「展开/收起」切换。
- **级别徽章：** 按严重度着色（error=红、warn=橙、info=蓝、debug=淡）并带来自 `counts` 载荷的实时计数。
- **提供方下拉：** 从当前流里见过的条目的 `provider` 字段动态填充。
- **清空按钮：** 确认动作，调 `POST /api/logs/clear`，然后失效查询缓存并重置本地状态。

---

## 导航

日志页从 **分析** 导航菜单链接过来
（`client/src/pages/AnalyticsPage.tsx` → 侧边栏）。它和分析图表并列，作为诊断伴侣：图表显示*发生了什么*（请求量、延迟、错误）；日志显示*为什么*。