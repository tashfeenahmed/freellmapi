[English](../../../../providers/03-adding-a-new-provider.md) · **简体中文**

# 添加新提供方

一篇贡献者走查，与现有 37 个内置平台的接入方式如出一辙。阅读时请把 [`server/src/providers/index.ts`](../../../../../server/src/providers/index.ts) 放在手边——它既是注册表，也是各平台取舍判断的最好文档。

## 1. 声明平台

在 [`shared/types.ts`](../../../../../shared/types.ts)（第 59 行）的 `Platform` 联合中加入 id，并附注释写明你能够辩护的免费额度事实：什么免费、循环发放还是促销、要不要信用卡、有没有注册墙。联合必须与 [`server/src/routes/keys.ts`](../../../../../server/src/routes/keys.ts) 的 `PLATFORMS` 白名单保持同步——那个 zod 枚举决定用户可以为哪些平台登记密钥。

## 2. 选择适配器

- **OpenAI 兼容端点** → 无需新类。带着平台 base URL 注册 `OpenAICompatProvider`，groq、cerebras、openrouter 以及另外约 27 家都是这么做的。
- **线上格式有分歧** → 在独立文件里子类化 `BaseProvider` 并注册。现有先例：
  - `GoogleProvider` —— 原生 Gemini 线上格式；
  - `CohereProvider` / `CloudflareProvider` / `ZhipuProvider` —— 兼容聊天路由外加密钥形状或控制台探测行为；
  - `PollinationsProvider` / `ModelScopeProvider` —— 因为它们的公开模型列表端点对坏密钥也返回 200，校验需要另一种探测；
  - `AIHordeProvider` —— 基于队列的代理，偏离 OpenAI 契约（`max_tokens >= 16`、仅数组的 `stop`、kudos 用量、无工具）。

每个适配器白得的功能：超时/停滞接线（`fetchWithTimeout`，首字节预算 #584）、带截断检测的 SSE 读取、`<think>` 提取，以及经 `providerHttpError` 的错误构造。

## 3. 用正确的选项注册

在 `index.ts` 里：

```ts
register(new OpenAICompatProvider({
  platform: 'yourplatform',
  name: 'Your Platform',
  baseUrl: 'https://api.example.com/v1',
}));
```

值得考虑的选项，每一个都有真实的注册在用：

| 选项 | 何时使用 | 示例 |
| --- | --- | --- |
| `timeoutMs` | 冷启动或隐藏推理超过默认的 15s；按调用覆盖仍然优先。 | google 60s, nvidia 180s, ollama/custom 120s |
| `keyless: true` | 免费档可以匿名使用。提供方省略 Authorization；密钥页会存一行哨兵记录，让路由把该平台视为已配置。 | kilo, ovh |
| `extraHeaders` | 提供方要求特定请求头。 | openrouter referer/title; routeway/navy browser-style User-Agent behind Cloudflare |
| `forceSingleToolCall` | 上游拒绝并行工具调用。 | nvidia (#255) |
| `validateUrl` | 密钥校验应探测 `/v1/models` 之外的另一个 URL。 | kilo probes `/api/gateway/models` |

可调的超时会经由 `PROVIDER_TIMEOUT_<PLATFORM>` 自动生效（#547）。

## 4. 把密钥校验做对

`validateKey` 返回布尔值或 `{ valid: false, error }`。用继承来的 `validationResult(res)` 助手把 401/403 变成携带上游原因的诊断性失败。两条从生产中学到的铁律：

1. **绝不要把公开的模型列表端点当成密钥有效的证据**（pollinations #608、modelscope）：如果 `GET /v1/models` 未鉴权也返回 200，就改为探测某个需要鉴权的东西。
2. **如果校验消耗计量额度，就缓存它或找一条免费探测** ——见 [#882](02-quotas-and-cooldowns.md#健康检查不得燃烧计量额度882)。健康检查每约 5 分钟对每条已存密钥跑一轮。

## 5. 有意识地播种目录

模型行来自两个地方，选错了会把付费模型泄漏给免费用户：

- **版本化迁移**（`migrateModelsV<N>`）用于随二进制发布的、经文档确认的免费名册（opencode V18、ovh V26）。
- **托管目录**，经 `services/catalog-sync.ts`（以 `hasProvider` 为门槛），当可用性应当集中管理时——如今通常是 Premium 先行，30 天观察期后转免费。绝不未经线上验证就从第三方列表播种：一个坏模型 id 宁可被健康检查抓住，也不作为默认值发布出去。

平台未公布限额时填 `null` 而不是猜；未知限额的冷却路径之所以把停用封顶在 10 分钟，正是因为猜测不等于测量。

## 6. 测试

在 [`server/src/__tests__/providers/`](../../../../../server/src/__tests__/providers/) 下按照既有模式补测试（一批 OpenAI 兼容注册参见 `cn-providers.test.ts`）：断言出站请求的形状（URL、鉴权头的位置、请求头）、响应归一化，以及你引入的任何怪癖处理。在仓库根目录用 `npm test` 跑完整链路——见 [docs/testing](../testing/OVERVIEW.md)。

## 清单

- [ ] `Platform` 联合与 `routes/keys.ts` 的 `PLATFORMS` 白名单一起更新
- [ ] 在 `providers/index.ts` 中注册，超时/请求头/免密钥的选择经得起推敲
- [ ] `validateKey` 对真实 401/403 正文和公开端点陷阱验证过
- [ ] 免费额度的说法经过线上核实（注释里写日期和观测，与 `index.ts` 其余部分一致）
- [ ] 明确做出目录播种决策（迁移 vs 托管目录 vs 不播种）
- [ ] 补了提供方测试；根目录 `npm test` 通过
