[English](../../../../providers/02-quotas-and-cooldowns.md) · **简体中文**

# 额度、冷却与密钥健康

免费额度以特定的、被计量的方式耗尽：每分钟和每日的请求上限、词元预算、并发限制，以及直接的额度枯竭。网关把这一切建模出来，让路由器不再把回退尝试浪费在明知已经花光的密钥上。相关机制位于 [`server/src/services/ratelimit.ts`](../../../../../server/src/services/ratelimit.ts)、[`server/src/services/provider-quota.ts`](../../../../../server/src/services/provider-quota.ts)、[`server/src/services/cooldown-probe.ts`](../../../../../server/src/services/cooldown-probe.ts)、[`server/src/services/health.ts`](../../../../../server/src/services/health.ts)，以及 [`server/src/providers/base.ts`](../../../../../server/src/providers/base.ts) 中共享的退避解析器。

## 限流窗口（RPM/RPD）

每条目录模型行都带有 `rpm_limit` / `rpd_limit` 列。派发一次尝试之前，路由器检查以 `platform:modelId:keyId:rpm`（分钟）或 `...:rpd`（天）为键的滑动窗口：

- 只有当 `recorded + in-flight < limit` 时请求才被放行——把进行中的租约计入，堵住了 N 个并发请求都读到同一个未消耗计数器的竞态。
- 窗口同时存在于内存和持久化存储中；数据库不可用时路由器回退为累加内存窗口键。

## 词元预算（TPM/TPD）

`tpm_limit` / `tpd_limit` 以估算词元按同样的方式工作：只有当 `used + in-flight tokens + estimate` 落在限额之内时，请求才计入其分钟/天词元窗口。由于有些提供方公布的 RPD 很宽裕而 TPM 却很小（代码里举了 groq 的 `gpt-oss-120b`：rpd 1000 但 tpm 8000），每日词元检查还会喂给一个推导出的上限，防止一次大爆发在几秒内烧光一整天的预算。

## 平台级共享池

按模型的窗口看不见账号层面的天花板：OpenRouter 把 `:free` 路由计量成一个池，Google 按项目计量，NVIDIA NIM 计量一个额度池（所有模型合计约每分钟 40 次请求，无视各模型行）。UnoRouter 的 `:free` 模型共享一个按分钟的账号级上限（一波并行请求会触发几分钟内所有 `:free` 模型的 429）。xKiro 的免费计划在所有免费模型（Mistral、MiniMax、DeepSeek 系列）间强制执行一个每日 500 万词元的账号级预算。`inferPoolForPlatform` 把平台映射到共享池（`openrouter::free`、`google::project`、`groq::account`、`nvidia::credit-pool`、`unorouter::free`、`xkiro::free` 等），每个池有自己的聚合闸门，`(models × rpd)` 式的扇出再也换不来意外 429。

## 并发租约

- **租约**让进行中的请求可见：每次派发的尝试都会获取一个租约，并在尝试落定后释放（释放是幂等的；泄漏的租约按年龄清理）。没有租约的话，计数器要等到 await 的提供方调用「之后」才写入，并行的流会径直越过限制、收获真实的 429。
- **可选的并发上限**：多数免费额度计量的是每分钟请求数而不是并行度，默认设上限只会白白串行化各个提供方。`MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>`（按平台）或 `MAX_CONCURRENT_REQUESTS_PER_KEY`（兜底）可启用一个对照实时租约数检查的按密钥上限。刻意不提供内置的按平台表：行为如此的提供方，文档精确得足以给出断言数字的还没有。

## 冷却

一次 429 会让那个「模型+密钥」组合停用一段时间：

| 机制 | 时长 | 备注 |
| --- | --- | --- |
| 瞬时冷却 | 90s | 分钟窗口内的 429；约一个窗口之内即可恢复。 |
| 升级阶梯 | 2min → 10min → 1h → 1 天 | 命中在一个滚动的 24 小时窗口上累计；真正耗尽的每日额度会把密钥隔离到当天结束，而不是反复走短冷却。一次成功的请求会清零命中计数。 |
| 未知限额的天花板 | 上限 10min | 当耗尽是猜测而非实测时，停用时长要有封顶，因为这个结论只是猜的。 |
| 需要付款（402） | 1 天 | 额度用光。 |
| 模型被禁（403 档位门槛） | 1 天 | 密钥有效，模型被划到更高档位。 |
| 本地端点错误 | 5s | 绝不进入阶梯。 |
| 鉴权失败（401） | 停用到下一轮健康周期 | 约 5 分钟。 |

### 来源与基于探测的提前恢复

冷却会记录它存在的原因（`heuristic`、`authoritative`、`credit`、`tier`）。只有 `heuristic` 类的停用属于猜测、常常比故障本身活得更久；提供方明说的事实（显式的 Retry-After 到期时间、每日额度的重置）以及 credit/tier 类停用绝不会被探测，因为一次通过的密钥校验对它们证明不了任何事。

冷却探测任务每 60 秒扫描一轮，重新校验探测时机成熟的密钥，提前解除启发式冷却：

- 只有过半停用期已过、且剩余超过 60s 才算成熟（探测一个快到期的停用纯属浪费一次校验调用）；
- 失败的探测绝不延长停用——它把下一次探测排得更远（2min 翻倍，封顶 15min）；
- 探测对健康账本无副作用，重启后错开执行，并且每轮有预算（`COOLDOWN_PROBE_MAX_PER_PASS`，默认 3）；`COOLDOWN_PROBE_DISABLED=1` 可杀死该任务；
- 探测的单位是「密钥」而非模型：一次 `validateKey` 的结果就是这把密钥持有的每一个启发式冷却的证据。

## 来自响应头与错误正文的退避（#798）

在 #798 之前，明确说了何时可以回来的提供方，得到的却和什么都没说的提供方同一套启发式阶梯，因为错误正文在到达路由器之前就被压扁成一条消息字符串。如今每个适配器都经 `providerHttpError` 构造错误，它会捕获：

1. **`Retry-After` 响应头** —— delta-seconds 或 HTTP-date，只解析一次（共享解析器在 `providers/base.ts`），且两种来源同时存在时仍是胜出通道。
2. **错误正文里写明的延迟**：
   - 结构化字段：Gemini 以 429 应答时带 `error.details[]`，其中 `google.rpc.RetryInfo` 的 `retryDelay` 读作 `"17s"`；正文会被深度封顶地遍历（最大深度 6），寻找 `retryDelay` / `retry_after` / `retryAfterSeconds` 形状——跨提供方比死路径更耐用；
   - 自然语言：锚定的短语如 "try again in 30 seconds" 或 "retry after 2m" ——之所以锚定，是为了让错误消息里无关的数字永远不可能被误认成退避时间。
3. 所有解析出的延迟都被钳制在 24h 内，畸形或恶意的提示不可能永久停用一个密钥。

只保留数字——正文从不保留——因此没有任何多余的东西进入日志或尝试轨迹。测试：[`server/src/__tests__/providers/stated-retry.test.ts`](../../../../../server/src/__tests__/providers/stated-retry.test.ts)。

## 健康检查不得燃烧计量额度（#882）

健康检查每 5 分钟跑一轮计划任务（±20% 抖动，3.5 分钟内校验过的密钥跳过，默认并发 8，同提供方探测之间间隔 ≥1s）。这个节奏对免费的校验端点没问题，在校验本身就耗费额度的地方却是毒药：

- ModelScope 用一次消耗额度的单词元聊天补全校验密钥（`GET /v1/models` 不做鉴权），花费魔粒额度——按默认节奏约合每密钥每天 288 次付费探测。修复（#882）：不带 `ms-` 前缀的令牌在本地直接拒绝、零网络调用，校验成功后按密钥缓存 `MODELSCOPE_VALIDATE_CACHE_MS`（默认 24 小时）。
- Pollinations 的公开 `/v1/models` 对已撤销的密钥也返回 200，所以校验指向需鉴权的 `/account/key`；AI Horde 则把任何可达的端点视为健康，而不去占用队列名额。

给贡献者的规则：**如果 `validateKey` 会消耗计量额度，就需要缓存或一条免费的探测路径** ——见 [03-adding-a-new-provider.md](03-adding-a-new-provider.md)。