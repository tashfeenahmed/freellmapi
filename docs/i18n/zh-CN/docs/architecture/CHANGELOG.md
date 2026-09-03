[English](../../../../architecture/CHANGELOG.md) · **简体中文**

# 架构域 —— 变更日志

`docs/architecture/` 的文档修订历史，从触及架构相关代码的提交播种而来。最近的在前。

## 2026-08-23 —— 领域扩展

- **提交（本 PR）**：`docs(architecture): expand into deep-dive domain`
  - 创建 `docs/architecture/` 领域文件夹，含 6 篇深度文档 + `OVERVIEW.md` + `CHANGELOG.md`
  - 根目录 `docs/architecture.md` 保留为高层索引，更新了交叉引用
  - `docs/OVERVIEW.md` 索引新增 architecture/ 域行

## 2026-06-xx —— 可观测性与日志

- **74df985** 仪表盘里的服务器日志查看器，位于分析导航菜单下 (#993)
  - 新增 `server-logs.ts`：双层存储（环形缓冲区 + 持久化 warn/error）
  - 新增 `GET /api/logs` API，带游标分页、级别/提供方/搜索过滤
  - 在 console 包装器层做日志脱敏（API 密钥、令牌、认证头）
  - 新增请求分析（`requests`、`request_attempts` 表）+ 聚合视图
  - 经 `AsyncLocalStorage` 做尝试追踪，服务 `X-Fallback-Detail` 头

## 2026-06-xx —— 路由与评分修复

- **f08e17c** fix(router): chars/4 欠计时的上下文窗口安全边际 (#956)
  - 路由词元估算现在把保留输出封顶 2000 词元（原为完整 max_tokens）
  - 防止在巨大客户端 max_tokens 时误把整个免费池排除
  - 输入仍全量计入；上游 429/413 由重试循环处理

- **a9895bc** Fix a batch of routing, streaming, and deployment quick wins (#941)
  - 路由器、代理、额度、目录同步上的多处小修复

- **4270280** fix(router): `MODEL_ROUTING_OVERRIDES` 永不生效时警告 (#738) (#857)
  - 保存时校验覆盖的模型 ID 在目录里存在

- **1fea8d5** fix(fallback): 测试间重置模型失败窗口并穿个可注入的 now (#856)
  - 模型失败停用的可测性改进

## 2026-05-xx —— 降级模式与回退 v2

- **f412e97** feat(server): 降级模式状态机 (#904) (#906)
  - 新增 `degradation.ts`：健康提供方比率追踪器，带迟滞
  - 比率 < 50% 持续 60s 进入降级（可配），高于阈值 120s 后退出
  - 降级态下：老虎机探索禁用，只按剩余健康提供方的评分顺序
  - 健康端点 + 仪表盘上报状态

- **1d2226a** feat(fallback): 重试时间预算过期时中止停滞尝试（对冲） (#828)
  - 挂钟预算中途过期时，`abortInFlight()` 经 `AbortController` 取消上游取获
  - `HedgeAbortError` = 非提供方健康 → 无冷却/惩罚
  - 渲染 `timedOut` 耗尽并附预算说明
  - 流式面在首字节时调 `ctx.disarmHedge()`

- **8cb75ac** feat(proxy): 可选 X-Fallback-Detail 头，带逐跳回退耗时 (#792)
  - `X-Fallback-Detail`：`platform/model keyN=outcome t=start+dur msg=summary; …`
  - 经 `EXPOSE_FALLBACK_DETAIL_HEADER=1` 或设置可选开启
  - 2KB 预算，单条摘要 120 字符，最多 10 跳

- **a961d93** fix(routing): 中继吐裸 "safe"/"unsafe" 分类输出时回退 (#809) (#830)
  - 探测中继模型（OpenCode Zen）的裸分类词
  - 视同空补全 → 回退，`finish_reason=length` 时 `skipBench: true`

## 2026-04-xx —— 路由增强

- **c3f538e** feat(routing): 经 `MODEL_ROUTING_OVERRIDES` 做按模型权重覆盖 (#747)
  - `MODEL_ROUTING_OVERRIDES='{"model-id": {"weight": 0.5}}'` 缩放最终有效分
  - 降级而不禁用；priority 链仍可选它

- **1e675cc** feat(routing): 把社区可靠性先验折入 Beta 后验 (#744)
  - 可选 `routing_community_prior_enabled` 把其他实例的去毒聚合计数折入
  - 每个先验封顶 50 个有效样本，让本地证据占主导

- **96da9ec** feat(routing): 给未测模型加探索开关 (#731)
  - `routing_explore_enabled=1` 给未测模型（<5 样本）保底 10% 优先尝试机会
  - 防止被先验重的对手饿死

- **fc4e47d** fix(router): 让超时费速度，并回写观测 speed_rank (#619)
  - 超时现在喂速度轴：封顶延迟（120s）+ 零词元 → 拖低吞吐
  - TTFB 样本在封顶延迟 → 过 `TTFB_WORST_MS` → 无延迟信用
  - 定期把有 ≥20 速度样本的模型的观测速度回写到 1..10 `speed_rank`

- **8ad9010** Fix routing chain semantics
  - priority 策略的密集秩 + 惩罚修复

## 2026-03-xx —— 额度与冷却引擎

- **076fa69** feat: 付费实时目录——签名同步、授权密钥、自助计费
  - 付费授权的实时目录层（2-3 天刷新）
  - 免费安装的月度快照层（30 天拖尾）
  - Ed25519 签名目录、钉死公钥、启动从缓存重应用
  - 模型年龄闸（30 天）、付费/免费层、迁移播种 vs 托管目录

- **75f0498** fix: Cloudflare 默认输出底线 + 给健康探测巡检限速 (#553) (#644)
  - 健康探测限速、Cloudflare 输出底线

- **8c9cf94** fix(ratelimit): 经命中启发式升级 NULL 限额提供方 (#392)
  - 无发布 RPD/TPD 的提供方：1 小时内 2+ 次 429 → "实际上每日耗尽"
  - 升级但封顶 10 分钟（`UNKNOWN_LIMIT_MAX_COOLDOWN_MS`）
  - 可逆：成功清空命中窗口

- **bfcef93** fix: 率账本漂移、词元双计、惩罚衰减、错误脱敏
  - 修在途租约核算、惩罚衰减、错误脱敏

- **67006c5** feat(routing): 停用密钥时遵从上游 Retry-After
  - Retry-After 作底线遵从，封顶 24h，来源 = 'authoritative'

- **2180ead** 按连接的提供方过滤 v1 models
  - `/v1/models` 按提供方密钥状态显示可用性

- **12166bd** feat(router): 跳过 tpm_limit 装不下请求的模型
  - 预检 TPM 对估算词元

- **438eaa2** feat(proxy): 智能体轮次完整性——流校验、工具方言救回、粘性会话修复 (#231 audit)
  - 流校验：头部拿到首载荷前保留
  - 工具方言救回：内联工具调用 → 结构化 tool_calls
  - 粘性会话：30min TTL，键 = 首条用户消息哈希

- **940986c** refactor(gateway): 统一四个提供方回退循环、修漂移 (#482 base) (#483)
  - 单 `fallback-loop.ts` 服务 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/completions`
  - 消除冷却、耗尽渲染、尝试轨迹的漂移

- **e57a0f8** feat(gateway): 回退硬化包（401 轮换、丰富耗尽、每日额度停用、截断策略、重试预算、用量兜底） (#484)
  - 401 → 即时密钥重校验 + 5min 停用
  - 每日额度耗尽 → 停用到 UTC 午夜
  - 重试时间预算（默认 45s）
  - 带尝试轨迹的丰富耗尽响应体

## 2026-02-xx —— 目录与提供方额度

- **2410f87** feat(catalog-sync): 每次启动重应用缓存目录
  - 解决漂移：迁移重断言基线、启动同步 304、缓存文档重应用

- **03480d8** feat(router): 强制提供方级每日请求上限 (#162)
  - OpenRouter 1000/天（<10 积分 50/天）、ModelScope 2000/天
  - 提供方级 RPM：NVIDIA NIM 40 RPM

- **a2d2a54** fix(routing): 多密钥额度修复 #470, #454, #456, #453 (#479)
  - 汇聚月度预算：`monthly_token_budget × usableKeyCount`
  - 模型内密钥评分做密钥选择

## 2026-01-xx —— 早期架构

- **413b5e4** feat(router): 分析驱动的老虎机路由，加权轴
  - 带可靠性/速度/智能轴的 Thompson 采样老虎机
  - 护栏：headroomFactor、rateLimitFactor
  - 策略预设：balanced、smartest、fastest、reliable、custom

- **dd46daf** fix(router): 连续 429 的升级冷却（credits @meliani） (#92)
  - 阶梯：2m → 10m → 1h → 24h，按模型+密钥滚动 24h 窗口

- **7cc751a** fix: 重启丢失率限与冷却状态 (#88)
  - 冷却持久化到 SQLite（`rate_limit_cooldowns` 表）

- **57541ea** fix(router): 把提供方 400 错误当可重试 (#80)
  - 400 → 回退而非硬错误

- **a27dc42** fix: 不可解密密钥能阻塞路由 (#85)
  - 解密错误 → 跳过密钥、不阻链

- **8aea92c** fix(router): 把 404 模型移除当可重试 (#76)
  - 404 → 回退到下一模型

- **839fe5a** fix(router): 把 413 Payload Too Large 当可重试 (#64)
  - 413 → 回退

- **2121550** feat(proxy): 在 `/v1/models` 里把 'auto' 暴露为虚拟模型 (#62)
  - `model: "auto"` 或省略 → 路由器选

- **9b97219** feat(router): 回退前穷尽所有密钥 + 测试 (#42)
  - 轮询完一个模型的所有密钥再去下一模型

## 2025 —— 基石

- **04e1503** FreeLLMAPI 初版发布
  - 基础路由、限流、提供方适配器、SQLite 存储