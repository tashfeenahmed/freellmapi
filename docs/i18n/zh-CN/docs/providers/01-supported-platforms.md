[English](../../../../providers/01-supported-platforms.md) · **简体中文**

# 支持的平台

[`shared/types.ts`（第 59 行）](../../../../../shared/types.ts) 中的 `Platform` 联合类型是平台身份的唯一事实来源；[`server/src/providers/index.ts`](../../../../../server/src/providers/index.ts) 中的运行时注册表必须与它保持一致。联合类型目前声明了 **41 个成员**：

- **39 个内置平台**，启动时注册为适配器；
- 加上 **`custom`** 占位（一个按 API 密钥逐个构建的真实 OpenAI 兼容适配器，因为它的 base URL 由用户提供），注册表共 **40 个条目**；
- 再加 **`sambanova`**——保留在类型联合中但不再注册：它在 V23（2026 年 6 月）被移除，当时它的免费额度被永久收回（一次性 $5 试用额度用完后，每次聊天调用都返回 402「需要绑定支付方式」）。

39 个内置平台中，**7 个使用专属原生适配器**，**32 个搭载 `OpenAICompatProvider`** 对着各自提供方专属的 base URL。三个平台以免密钥方式注册（`kilo`、`ovh`，以及 `aihorde`——它用文档记载的匿名哨兵密钥自动配置）。README 里的公开目录招牌数字约为 29 家免费提供方 / 251 个模型系列 / 358 个免费端点——比联合类型少，因为若干已注册的网关把免费名册放在托管目录里维护，而不是随每个二进制一起发布。

## 目录

| 平台 | 显示名称 | 鉴权 | 适配器 | 备注 |
| --- | --- | --- | --- | --- |
| `google` | Google Gemini | 带密钥 | 原生（`GoogleProvider`） | Gemini 线上格式；默认超时 60s，因为 Gemma 推理变体冷启动要花 20–60 秒。 |
| `groq` | Groq | 带密钥 | OpenAI 兼容 | `api.groq.com/openai/v1` 的标准兼容端点。 |
| `cerebras` | Cerebras | 带密钥 | OpenAI 兼容 | `api.cerebras.ai/v1`。 |
| `bai` | B.AI | 带密钥 | OpenAI 兼容 | #918 加入的网关；目录里唯一的一行是限时 0 额度促销，保留在托管目录中。 |
| `anyapi` | AnyAPI | 带密钥 | OpenAI 兼容 | 免费档 $0 / 无需信用卡 / 不循环扣费，上限为「免费和基础」模型每日 10 万词元；未公布 RPM/RPD（#772）。模型 id 经由目录同步送达，绝不盲目播种。 |
| `nvidia` | NVIDIA NIM | 带密钥 | OpenAI 兼容 | `parallel_tool_calls` 固定为 false（#255）；180s 超时兼任流式首字节宽限（#584）。 |
| `mistral` | Mistral | 带密钥 | OpenAI 兼容 | `api.mistral.ai/v1`。 |
| `sambanova` | SambaNova | 已退役（V23） | 未注册 | 免费额度永久消失；因历史密钥行而保留在类型联合中。 |
| `openrouter` | OpenRouter | 带密钥 | OpenAI 兼容 | 发送 `HTTP-Referer`/`X-Title` 头；`:free` 模型后缀标记零成本路由。 |
| `github` | GitHub Models | 带密钥 | OpenAI 兼容 | 路由到 `models.github.ai/inference`；目录使用 `<publisher>/<model>` 形式的 id。 |
| `cohere` | Cohere | 带密钥 | 原生（`CohereProvider`） | 使用 Cohere 的 OpenAI 兼容端点。 |
| `cloudflare` | Cloudflare Workers AI | 带密钥（`account_id:token`） | 原生（`CloudflareProvider`） | 复合凭据格式由适配器解析。 |
| `zhipu` | Zhipu (Z.ai / bigmodel.cn) | 带密钥 | 原生（`ZhipuProvider`） | 控制台自动探测：国内密钥被拒后会改向全球 `api.z.ai` 主机重新探测；60s 超时覆盖 glm-4.7-flash 的隐藏推理。 |
| `ollama` | Ollama Cloud | 带密钥 | OpenAI 兼容 | 为前沿推理模型设 120s 超时；推理内容放在 `message.reasoning` 里返回；目录过滤到确认免费的行。 |
| `kilo` | Kilo Gateway | 免密钥 | OpenAI 兼容 | 匿名 `:free` 路由按 IP 限流每小时 200 次请求；提示词/输出会被记录用于训练；校验探测 `/api/gateway/models`（#181）。 |
| `pollinations` | Pollinations | 带密钥 | 原生（`PollinationsProvider`） | 即使密钥已被撤销，`GET /v1/models` 也返回 200，因此校验改为探测需鉴权的 `/account/key`（#608）。 |
| `llm7` | LLM7.io | 带密钥（基础模型可匿名） | OpenAI 兼容 | 免费档每小时 100 次请求。 |
| `huggingface` | Hugging Face Router | 带密钥 | OpenAI 兼容 | `router.huggingface.co` 元路由器（V13 重新加入）；免费档每月循环发放 $0.10 路由额度。 |
| `opencode` | OpenCode Zen | 带密钥 | OpenAI 兼容 | 仅限试用的促销免费名册，经文档确认的 id 通过 `migrateModelsV18` 播种。 |
| `ovh` | OVHcloud AI Endpoints | 免密钥 | OpenAI 兼容 | 匿名档：每 IP 每模型每分钟 2 次请求（实测更严）；鉴权档要求绑定了支付方式的 Public Cloud 项目（`migrateModelsV26`）。 |
| `agnes` | Agnes AI | 带密钥 | OpenAI 兼容 | 专有模型以 $0/词元促销提供；约 30 个并发请求后开始出现 429；为推理首字节设 60s 超时。 |
| `reka` | Reka | 带密钥 | OpenAI 兼容 | 通过每月循环的额度赠金免费（无需信用卡）；余额只在仪表盘可见。 |
| `siliconflow` | SiliconFlow | 带密钥 | OpenAI 兼容 | 主要为 FREE 生成媒体模型而注册（FLUX.1-schnell 图像、CosyVoice2 TTS），经由 `services/media.ts` 路由。 |
| `routeway` | Routeway | 带密钥 | OpenAI 兼容 | 要求浏览器风格的 User-Agent（Cloudflare 对其他值报错误 1010）；实测免费池约 5 rpm，比文档写的 20 rpm / 200 rpd 更严。 |
| `bazaarlink` | BazaarLink | 带密钥 | OpenAI 兼容 | 只有 `auto:free` 路由进了目录——直接指定模型 id 是付费的（#385）。 |
| `ainative` | AINative Studio | 带密钥 | OpenAI 兼容 | 宣称每月循环约 1000 万词元的免费配额；在真实账号确认之前按未核实处理。 |
| `aion` | Aion Labs | 带密钥 | OpenAI 兼容 | 无需信用卡的免费密钥；可用性在 30 天观察期之后交由目录管理。 |
| `requesty` | Requesty | 带密钥 | OpenAI 兼容 | 路由端点位于 `router.requesty.ai/v1`；免费行随月度目录逐步纳入。 |
| `navy` | NavyAI | 带密钥 | OpenAI 兼容 | 免费计划：每日 15 万词元、20 RPM；线上冒烟测试需要显式 User-Agent 头。 |
| `nara` | NaraRouter | 带密钥 | OpenAI 兼容 | 免费计划额外要求 Telegram 频道/链接验证；2026 年 7 月 9 日做过线上探测。 |
| `sealion` | SEA-LION (AI Singapore) | 带密钥 | OpenAI 兼容 | 第一方 API；Google 登录、无需信用卡、没有地区墙；免费档每月循环 10 RPM。 |
| `orcarouter` | OrcaRouter | 带密钥 | OpenAI 兼容 | 循环 `$0` 免费别名，限额刻意不予公布（#896）：429 是干净的额度信号，因为免费路由从不回退到付费模型。 |
| `unorouter` | UnoRouter | 带密钥 | OpenAI 兼容 | 免费模型带 `:free` 后缀；每分钟限流（达上限即 429）。`GET /v1/models` 公开（无密钥也返回 200），但错误密钥会得到 401；默认密钥校验有效。目录行在托管目录中（目前是付费，30 天观察期后转免费）。 |
| `xkiro` | xKiro | 带密钥 | OpenAI 兼容 | 免费计划：免费模型（Mistral、MiniMax、DeepSeek 系列）每日 500 万词元；付费模型返回 403。`GET /v1/models` 公开（无密钥返回 200），所以 `validateUrl` 指向 `/v1/usage`，缺失或无效密钥时返回 401。接受 Bearer 或 `x-api-key`。目录行在托管目录中（目前是付费，30 天观察期后转免费）。 |
| `modelscope` | ModelScope (Alibaba) | 带密钥 | 原生（`ModelScopeProvider`） | 调用需要绑定完成实名的阿里云中国站账号；`GET /v1/models` 接受任意垃圾令牌，所以校验采用单词元聊天探测；退役模型以 429「余额不足」回应（#581）。 |
| `qianfan` | Baidu Qianfan | 带密钥 | OpenAI 兼容 | ERNIE-Speed/Lite/Tiny 以按量计费封顶于限流规则的方式长期免费；需要中国实名认证（#936）。 |
| `volcengine` | Volcengine Ark (ByteDance) | 带密钥 | OpenAI 兼容 | 个人开发者在一次性 50 万词元新用户赠金之外，还有每模型每日 200 万词元的循环奖励额度；需要实名认证（#936）。 |
| `longcat` | LongCat (Meituan) | 带密钥 | OpenAI 兼容 | 每日免费额度；是中国提供方中的例外——中国大陆之外也能用邮箱注册。同时在 `/anthropic` 提供 Anthropic 线上格式（此处未使用）（#936）。 |
| `xfyun` | iFlytek Spark | 带密钥 | OpenAI 兼容 | 鉴权是把控制台的 APIPassword 当作 Bearer 令牌使用；Lite 是文档记载的免费模型；未公布词元/QPS 上限（#936）。 |
| `aihorde` | AI Horde | 免密钥（匿名哨兵 `0000000000`；注册密钥可提升队列优先级） | 原生（`AIHordeProvider`） | 社区志愿算力经队列代理接入：max_tokens >= 16、stop 必须是数组、不支持工具、用量以 kudos 计、120s 超时、无上游流式（#345）。 |
| `custom` | 自定义（OpenAI 兼容） | 用户提供的 base URL 存于各 `api_keys` 行 | 经 `resolveProvider()` 按密钥构建的 OpenAI 兼容适配器 | 注册占位让 `getProvider('custom')`/`hasProvider('custom')` 行为良好；为缓慢的本地运行时（llama.cpp、vLLM、LM Studio）设 120s 超时（#145）。 |

## 相关历史

- Moonshot 直连集成与 MiniMax 直连在 `migrateModelsV4` 中移除（仅付费 / 被 OpenRouter 路线取代）。
- Hugging Face 在 V4 中移除（「工具调用格式问题」），并在 V13 经 Inference Providers 元路由器重新加入。
- Chutes 曾为 V11 评估过然后放弃：所有模型都返回 402 要求非零余额，与项目「无需信用卡」的标准冲突。