[English](../../../../env/01-variables.md) · **简体中文**

# 环境变量参考

FreeLLMAPI 从 `.env` 读取的全部变量，按主题分组。默认值和说明仅依据 [`.env.example`](../../../../../.env.example) 中的注释与取值推导而来。在 `.env.example` 中以注释形式出现的变量是可选的；此处列出的是它们文档记载的默认值。

- [服务器与绑定](#服务器与绑定)
- [出站代理（本地目的地）](#出站代理本地目的地)
- [安全与加密](#安全与加密)
- [限流](#限流)
- [路由覆盖、超时与故障转移](#路由覆盖超时与故障转移)
- [出站代理](#出站代理)
- [请求正文与媒体限制](#请求正文与媒体限制)
- [存储、缓存、分析与杂项](#存储缓存分析与杂项)

相关阅读：[02-security-and-keys.md](02-security-and-keys.md) 详述 `ENCRYPTION_KEY`；[03-outbound-proxies.md](03-outbound-proxies.md) 详述代理链。

## 服务器与绑定

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3001` | 服务器端口。 |
| `HOST` | `::`（IPv4+IPv6 双栈） | 服务器监听的网络接口。禁用了 IPv6 的主机会自动回退到 IPv4。设为 `0.0.0.0` 表示仅 IPv4，设为 `127.0.0.1` 则只允许本机访问。注意与 `HOST_BIND` 区分：后者只影响 Docker 的端口发布。 |
| `HOST_BIND` | `127.0.0.1` | 仅 Docker 有效：容器的端口发布在宿主机的哪个接口上。默认值让仪表盘/API 只能从运行 Docker 的那台机器访问；设为 `0.0.0.0` 可对局域网开放（例如树莓派上的 `http://192.168.1.x:3001`）——只在可信网络上这么做，因为这个代理是单用户的，唯一的防护就是统一 API 密钥。 |
| `DASHBOARD_ORIGINS` | 允许 `localhost:5173`、`127.0.0.1:5173`、`[::1]:5173` | 额外允许从浏览器调用 API 的来源，逗号分隔。只有当仪表盘部署在与 API 不同的主机上时才需要（例如 `http://my-server.local`）。 |
| `CSP_UPGRADE_INSECURE_REQUESTS` | 自动（未设置） | 控制 Content-Security-Policy 的 `upgrade-insecure-requests` 指令（#682）。未设置：仅当请求经 TLS 到达、或位于 HTTPS 反向代理之后（`X-Forwarded-Proto: https`）时才输出该指令，纯 HTTP 的局域网安装仍可正常渲染。`true`：即使走纯 HTTP 也强制开启该指令（很少有用）。`false`：即使在 HTTPS 之后也强制关闭（例如存在混合内容的反向代理）。 |

## 出站代理（本地目的地）

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `FREEAPI_PROXY_LOCAL_DESTINATIONS` | `false` | 允许代理 localhost/局域网目的地（Ollama、llama.cpp、LM Studio）。默认情况下本地和局域网目的地（localhost、127.0.0.0/8、::1、0.0.0.0、RFC1918/ULA/CGNAT 地址）总是绕过出站代理——远程代理没有路由回你自己的机器。仅当代理它们才是目的时设为 `true`，例如 `ssh -D` 动态隧道，其中经由 SOCKS 代理的 `http://127.0.0.1:11434` 本意是要到达**远程**主机的 Ollama。 |

## 安全与加密

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | 占位值；生产环境必填，非生产环境使用自动生成的密钥文件 | 用于 API 密钥存储的服务器加密密钥。生成方式：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。优先级：先看这个环境变量，再看 SQLite 数据库旁边的 `.encryption-key` 文件（不在数据库里面，权限 0600），再看旧 settings 表里的遗留密钥（首次启动时迁移到文件），最后才新生成一把密钥。参见 [02-security-and-keys.md](02-security-and-keys.md)。 |
| `FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS` | 未设置——自定义提供方仍然允许 localhost 和私有局域网地址 | 自定义提供方的 URL 策略。云元数据和链路本地地址（`169.254.169.254`、`metadata.google.internal`、`fe80::/10` 等）作为自定义提供方 base URL 时一律被阻止。设为 `true` 可以连环回地址和 RFC1918/ULA 私有网段一起阻止——把服务放在 VPS 或任何别人能访问到仪表盘的地方时建议开启。 |
| `FREEAPI_DB_DIR_HARDENING` | 在安全的前提下自动启用 | 是否把存放数据库的目录限制为本账户可见，这样 SQLite 的 `-wal`/`-shm` 边车文件也能得到保护（它们在第一次写入时才创建，任何启动期的权限检查都来不及顾及）。对默认的 `server/data` 目录以及 FreeLLMAPI 自行创建的目录会自动执行；`FREEAPI_DB_PATH` 指向某个已存在的目录时会跳过，因为那里可能是共享位置。设为 `1` 强制启用，设为 `0` 彻底关闭。 |

首次运行说明：第一个仪表盘账户通常在同一台机器的浏览器里创建，无需额外步骤。如果服务器能被其他设备访问到，创建这第一个账户还需要一个一次性的安装码，它会在尚无账户时的启动阶段打印到服务器日志中。

## 限流

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PROXY_RATE_LIMIT_RPM` | `120` | 每个客户端 IP 每分钟可发送的 `/v1` 代理请求上限。设为 `0` 可关闭代理限流。相关的旋钮见 [03-outbound-proxies.md](03-outbound-proxies.md)。 |
| `ADMIN_RATE_LIMIT_RPM` | `600` | 每个客户端 IP 每分钟可发送的 `/api` 仪表盘请求上限。这是一道防洪水闸——登录有自己的按邮箱锁定机制，密钥导出则有自己严格得多的上限。设为 `0` 关闭。 |

## 路由覆盖、超时与故障转移

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MODEL_ROUTING_OVERRIDES` | 未设置 | 按模型的路由评分乘数（#738），JSON 对象，键为模型 id，值为 `0..2`。`1.0` 保持不变，低于 `1` 降低优先级，高于 `1` 提升优先级，`0` 表示自动路由器绝不选它（手动指定优先级仍可用）。匹配只按模型 id 进行，覆盖所有提供该 id 的平台，精确且区分大小写；id 可以从仪表盘的模型页复制。匹配不到任何模型的 id 会被静默忽略，但目录同步完成后，启动日志会对它警告一次。 |
| `PROVIDER_TIMEOUT_<PLATFORM>` | 内置于各提供方：多数 OpenAI 兼容平台 `60s`，NVIDIA `180s`，Ollama Cloud / AI Horde / 自定义提供方 `120s`，Google 注册时为 `60s` | 各提供方的聊天 HTTP 超时时间，单位毫秒（平台名大写）。对流式请求，这个值同时充当首字节的宽限预算：流在首个字节之前可以沉默多久（issue #584——NVIDIA NIM 这类提供方会立刻发回 SSE 响应头，然后花几分钟预填充长提示词）。`0` 彻底关闭超时。启动时读取。示例：`PROVIDER_TIMEOUT_NVIDIA=300000` 给 NVIDIA NIM 缓慢的推理模型 5 分钟。 |
| `PROVIDER_STREAM_STALL_TIMEOUT_MS` | `90000` | 流中途的停滞超时，单位毫秒。如果一条 SSE 流在首字节已到达之后持续这么久没有任何字节，网关就放弃：若尚无输出到达客户端，则故障转移到下一个候选；若已有输出，则以一个错误帧结束流。到「第一个」字节为止的时间由 `PROVIDER_TIMEOUT_<PLATFORM>` 管（两者取较大者）。在免费额度上排长队的提供方可能在流中途停顿超过 90 秒——如果流式响应总是提前中断，就调高这个值。`0` 彻底关闭停滞看门狗。 |
| `PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>` | 先回落到上面的全局值，再到内置的 `90000` | 按提供方的变体（平台名大写）。优先级：按平台 > 全局 > 内置 90 秒默认。示例：`PROVIDER_STREAM_STALL_TIMEOUT_OLLAMA=240000` 允许 Ollama Cloud 在流中途停顿 4 分钟，而其他地方的看门狗不受影响。 |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | 各提供方内置的默认值 | 按提供方的每日请求上限（平台名大写）。覆盖该提供方的内置默认值；设为 `0` 关闭上限。示例：`PROVIDER_DAILY_REQUEST_CAP_OPENROUTER=50`。 |
| `FALLBACK_TIME_BUDGET_MS` | `45000` | 提供方故障转移的挂钟时间预算，单位毫秒。一个不断失败转移的请求，一旦耗时超过这个预算就不再「发起」新的尝试，改为返回耗尽错误（第一次尝试总会执行；进行中的尝试绝不会被拦腰截断）。`0` 表示不限制，一直重试直到触及尝试次数上限。也可以在运行时通过 `fallback_time_budget_ms` 设置键修改，后者优先。 |
| `FALLBACK_DETAIL_HEADER` | 关闭 | 可选开启的 `X-Fallback-Detail` 响应头（`=1` 开启）。`X-Fallback-Trail` 已经列出了每一跳的失败原因；这个详情头额外给出每一跳的「代价」——例如 `groq/llama-3.3-70b key1=rate_limited t=0+39000ms msg=...`——这样调用者不用打开仪表盘就能分辨一次 39 秒的卡顿和四次快速失败。默认关闭，因为它会把各跳的耗时和提供方错误文本暴露在响应上。运行时通过 `expose_fallback_detail_header` 设置键覆盖，后者优先。 |
| `VALIDATE_TOOL_ARGUMENTS` | 关闭（`=1` 开启） | 对照调用方声明的 schema 校验工具调用参数，违反时触发故障转移。`lib/tool-args.ts` 已经修复它能确证可修的部分；这个开关负责剩下的漏网之鱼——它们如今到达 Anthropic 客户端时会是一个带 `input: {}` 的 `tool_use` 块。默认关闭，因为误报的代价是一跳故障转移——先打开它，盯着 `X-Fallback-Trail` 观察 `invalid_tool_arguments`，再决定去留。适用于回合仍可故障转移的所有场合（非流式端点，外加 `/v1/chat/completions`、`/v1/messages`、Gemini 与 Ollama 模拟）；`/v1/responses` 的流式在第一个工具调用增量上就已提交，属于例外。运行时通过 `validate_tool_arguments` 设置键调整。 |
| `REQUEST_MAX_TOKENS_BUDGET` | `0`（关闭） | 按请求的词元护栏：估算输入词元加所请求的 max_tokens 必须落在这个上限之内，否则在任何提供方被尝试之前就以 413 拒绝请求；没有发送 max_tokens 的请求，其输出会被截断到剩余额度。可在运行时通过 `request_max_tokens_budget` 设置键调整（仪表盘 API `PUT /api/settings/guardrails`）。 |
| `MAX_CONSECUTIVE_UPSTREAM_FAILS` | `0`（关闭） | 故障转移断路器：单个请求内连续上游失败达到这个次数后，以 503 终止故障转移链，而不是在一个不健康的池子里试遍每个剩余候选。可在运行时通过 `max_consecutive_upstream_fails` 设置键调整。 |
| `MODELSCOPE_VALIDATE_CACHE_MS` | `86400000`（24 小时） | ModelScope（魔搭）用一次消耗额度的单词元聊天补全来校验 API 密钥（`GET /v1/models` 不做鉴权），每次探测都要花费魔粒额度——实测每个超档请求约 2 魔粒。为了不让每 5 分钟一轮的健康检查每天烧掉约 288 次付费探测，校验成功后会按密钥缓存这么长时间（毫秒）。`0` 表示每轮都探测；被撤销的密钥仍会被下一次真实请求的 401 抓住。 |
| `FREELLMAPI_CONTEXT_HANDOFF` | 关闭 | 模型切换时的上下文交接。启用后（`on_model_switch`），每当一个会话从一个模型切换到另一个（例如发生故障转移之后），FreeLLMAPI 会向出站请求注入一条精简的系统消息。 |

## 出站代理

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PROXY_URL` | 未设置 | 提供方请求的出站代理。通常在仪表盘里设置（密钥 → 出站代理）；环境变量是为无界面的安装准备的。协议：`http`、`https`、`socks4`、`socks4a`、`socks5`、`socks5h`——带 `h`/`a` 的变体在代理解析 DNS，这正是 DNS 污染网络下想要的。位于下方优先级链的最高一环。 |
| `ALL_PROXY` | 未设置 | 标准代理变量，优先级链第三位。 |
| `HTTPS_PROXY` | 未设置 | 标准代理变量，优先级链第四位。 |
| `HTTP_PROXY` | 未设置 | 标准代理变量，优先级链最后一位。 |
| `NO_PROXY` | 未设置 | 必须直连、绕开上述代理的主机。逗号分隔；裸域名同时涵盖其子域名，`*` 则彻底禁用代理。 |

**优先级：** `PROXY_URL` → 仪表盘设置 → `ALL_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`。标准变量的全小写拼写同样会被读取。

在 Docker 里，`127.0.0.1` 指的是容器而不是你的机器——见 [03-outbound-proxies.md](03-outbound-proxies.md)。

## 请求正文与媒体限制

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `REQUEST_BODY_LIMIT_MB` | `25` | 推理端点（`/v1`、`/v1beta`、`/mcp`、Ollama `/api/*`）的 JSON 正文大小上限，单位 MB。视觉请求会把 base64 图片嵌进正文并随每一轮回放，大型会话很容易超过 10MB；这个上限只管解析——入站图片归一化随后会缩小载荷。如果更大的载荷被 413 `request_too_large` 拒绝，就调高它。 |
| `IMAGE_NORMALIZE` | `on` | 入站图片归一化的总开关（`off` 彻底关闭）。超过阈值的数据 URL 图片会在路由前被降采样到长边上限并重新编码（JPEG，或仅在 alpha 通道携带真实透明度时保留 PNG），把回放的截图缩小约 6–10 倍。同时会把上游拒收的冷门格式归一化（bmp/gif/tiff/avif/webp → jpeg/png）；gif 只保留第一帧。反正每个上游内部都会自行缩放（OpenAI 到 2048px，Anthropic 到 1568px），超出上限的像素纯属传输浪费。 |
| `IMAGE_NORMALIZE_MAX_DIMENSION` | `2048` | 归一化图片的长边像素上限。 |
| `IMAGE_NORMALIZE_THRESHOLD_KB` | `1024` | 超过这个大小（KB）的图片才会进入降采样候选。 |
| `IMAGE_NORMALIZE_QUALITY` | `90` | 归一化图片重新编码的质量。 |

## 存储、缓存、分析与杂项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RESPONSE_CACHE` | `false` | 可选开启的响应缓存。开启后，一次成功的非流式 `/v1/chat/completions` 回答会存进一个有界的内存 LRU（以整个请求的规范化哈希为键），因此完全相同的后续请求直接由内存应答，不再消耗提供方额度。只做精确匹配——近似请求绝不会返回另一个提示词的答案。可在运行时通过仪表盘切换（`PUT /api/cache/config`），也可按请求用 `X-FreeLLM-Cache: on\|off` 头控制。重启即清空。 |
| `RESPONSE_CACHE_TTL_SECONDS` | `3600`（1 小时） | 缓存的回答保持新鲜多久，单位秒。 |
| `RESPONSE_CACHE_MAX_TEMPERATURE` | `1.0` | 只缓存温度不高于该值的请求；更高的温度需要新鲜多样的输出。默认在开启时全部缓存；调低它（如 `0.2`）则只缓存接近确定性的调用。 |
| `RESPONSE_CACHE_MAX_ENTRIES` | `5000` | 存储条目的硬上限；超过后按最近最少使用逐出。 |
| `FREELLMAPI_COMPRESSION` | `off` | 请求侧的提示词/上下文压缩。`lossless` 应用空白清理、完全重复块的引用以及可逆的表格化 JSON 编码；`standard` 再过滤工具输出和已被取代的文件读取；`aggressive` 追加基于年龄/相关性/预算的浓缩。仪表盘可以在设置里实时更改。单个请求可以用 `X-FreeLLM-Compress` 把配置的模式调低，但不能越过全局 `off` 总开关。 |
| `REQUEST_ANALYTICS_RETENTION_DAYS` | `90` | 请求分析的留存天数。设为 `0` 取消此限制。 |
| `REQUEST_ANALYTICS_MAX_ROWS` | `100000` | 请求分析的行数上限。设为 `0` 取消此限制。 |
| `REQUEST_ANALYTICS_LOG_CLIENT` | `true` | 把每次请求的调用者身份（客户端 IP + User-Agent）记入请求分析，并显示在仪表盘的「最近调用」表里。设为 `false` 则改存 null（聚合分析不受影响）。 |
| `SERVER_LOGS_RETENTION_DAYS` | `7` | 仪表盘日志查看器后面的持久化服务器日志。只有 warn/error 行会写入数据库（实时视图是内存环），所以这些界限比上面的分析界限紧得多。设为 `0` 取消此限制。 |
| `SERVER_LOGS_MAX_ROWS` | `50000` | 持久化服务器日志的行数上限。设为 `0` 取消此限制。 |
| `FREEAPI_DB_PATH` | 默认位置，紧邻 server 构建产物 | 可选的 SQLite 位置覆盖。适合只有某一个目录做了持久化挂载的主机，或者想把数据库放到 `server/data` 之外的场景。示例：`/app/server/data/freellmapi.db`。 |
| `FREEAPI_DB_BACKUP_PATH` | 未设置 | 可选的加密 SQLite 备份目标（文件路径）。启动时若配置的数据库文件缺失，FreeLLMAPI 会恢复这份备份；运行期间则定期上传新的备份。 |
| `FREEAPI_DB_BACKUP_URL` | 未设置 | HTTP(S) 备份目标，上面路径的替代方案。 |
| `FREEAPI_DB_BACKUP_TOKEN` | 未设置 | 向 `FREEAPI_DB_BACKUP_URL` 上传时可选的 bearer 令牌。 |
| `FREEAPI_DB_BACKUP_KEY` | 省略时使用 `ENCRYPTION_KEY` | 备份信封专用的 64 位十六进制密钥，可与主密钥分开。 |
| `FREEAPI_DB_BACKUP_INTERVAL_MS` | `300000`（5 分钟） | 后台备份之间的间隔。 |
| `FREEAPI_CONFIG_PATH` | 未设置 | 可选的声明式启动配置：指向一个 JSON 文件的路径，每次启动都会在迁移之后幂等地应用。示例：`/app/server/data/freellmapi.config.json`。 |
| `FREEAPI_CONFIG_JSON` | 未设置 | 同样的声明式配置，以内联方式而非文件给出，例如 `{"keys":[{"platform":"groq","key":"gsk_...","label":"main"}],"routing":{"strategy":"balanced"}}`。 |
| `FREELLMAPI_UPDATE_CHECK` | 启用 | 手动的应用更新检查器。设为 `off` 可把它从设置页隐藏，并阻止 Git 发现和对外发出的更新检查请求。这也会一并关掉自动版本提醒——那是另一个独立的仪表盘设置项（设置 > 通用），在被打开之前始终保持关闭。 |
| `FREELLMAPI_UPDATE_GITHUB_TOKEN` | 空（匿名检查） | 仅用于对 GitHub 做更新检查的令牌。检查器默认匿名；只有在需要更高限额时才使用窄权限令牌。通用的 `GITHUB_TOKEN` 会被有意忽略。 |
| `FREELLMAPI_COMMIT_SHA` | 由官方构建注入 | 标识确切提交的构建元数据。一般不应写进 `.env`。 |
| `FREELLMAPI_INSTALL_METHOD` | 由官方构建注入（Docker 镜像设为 `docker`） | 更新检查器使用的安装类型元数据。一般不应写进 `.env`。 |
| `CLIENT_DIST` | 随附的客户端构建 | 指向要伺服的预构建客户端 `dist` 目录的路径。只有单独构建仪表盘时才需要设置。 |
| `FREEAPI_ENV_PATH` | `./.env` | 要加载的 `.env` 文件的显式路径。对嵌入式场景有用（例如桌面应用，代码从打包内部运行）；dotenv 对缺失文件静默忽略。 |