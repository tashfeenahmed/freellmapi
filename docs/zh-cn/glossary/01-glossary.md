[English](../../en/glossary/01-glossary.md) · **简体中文**

# 术语表

| 术语 | 含义 |
| --- | --- |
| **余量（Headroom）** | 模型/密钥在触及限流前的剩余额度：`1 − max(RPM/RPD/TPM/TPD 已用)`。`0`=已耗尽，`1`=满额。可通过 `HEADROOM_RAMP_START`/`HEADROOM_FLOOR` 调节（见 `../architecture/01-routing-and-bandit-scoring.md`）。 |
| **RPD / TPD** | 每日请求数 / 每日词元数 —— 每日额度窗口（`ratelimit.ts:modelWindowUsedFraction`，5 秒 TTL）。 |
| **RPM / TPM** | 每分钟请求数 / 每分钟词元数 —— 短窗口额度。 |
| **池键（Pool key）** | 共享额度池标识符（`provider-quota.ts:inferQuotaPoolKey`），例如 `openrouter::free`、`google::project`、`custom::key123`。同一池中的密钥共享同一额度。 |
| **最少剩余（Least-remaining）** | 密钥选择策略（`c4c0221`），挑选池中剩余额度最多的密钥（`services/router.ts:getKeySelectionStrategy`），跳过 `::account` 池。 |
| **`auto:<name>`** | 命名回退链以可选模型形式暴露在 `GET /v1/models` 中（`cc1e985`）——例如 `auto:fast` 仅通过该链路由。 |
| **模型年龄闸（Model-age gate）** | 目录同步规则：新模型在 30 天内为 `premium`，随后在下一次签名同步时变为 `free`（`services/catalog-sync.ts`）。 |
| **老虎机路由（Bandit router）** | Thompson 采样路由器（`services/router.ts` + `scoring.ts`），在可靠性/速度/智能/余量后验之间权衡，并保留 10% 探索。 |
| **在途窗口（In-flight window）** | 并发请求去重窗口 —— **不**为幂等去重（`95bc46f`，`services/idempotency.ts:16-20`）—— 使用相同 `Idempotency-Key` 的并发重试可能产生竞态。 |
| **TRUST_PROXY** | 环境变量（`.env.example:314`，`lib/config.ts:95-110`），转发给 Express `trust proxy`，以便分析/限流通过 `X-Forwarded-For`/`Proto` 看到真实客户端 IP。默认 `false`（不信任伪造）。 |
| **`FREEAPI_SHOT`** | 桌面端截图模式标志，位于 `desktop/src/main.ts`。 |
| **`freellmapi-…`** | 汇聚回退链标识符 —— 网关的单一逻辑模型，经由回退阶梯扇出。 |

另见：[架构](../architecture/OVERVIEW.md)、[路由与老虎机评分](../architecture/01-routing-and-bandit-scoring.md)、[额度与冷却引擎](../architecture/02-quota-and-cooldown-engine.md)。
