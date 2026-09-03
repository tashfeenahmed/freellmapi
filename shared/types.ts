// ---- Platform & Model Types ----

/** How the global outbound proxy URL is interpreted. Per-key proxies always
 * use the traditional forward-proxy transport. */
export type ProxyMode = 'forward' | 'fetch-relay';

/** A model declared beside a custom endpoint in an import file (#382). A
 *  capability flag is present only when the paste declared it via a trailing
 *  -TOOLS / -VISION suffix. */
export interface ImportModelEntry {
  id: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface PreviewKey {
  keyName: string;
  keyValue: string;
  detectedPlatform: string | null;
  prefix: string;
  /** Custom endpoints only: the upstream URL the export file carried (#687). */
  baseUrl?: string;
  /** Custom endpoints only: models to register alongside the key (#382). */
  models?: ImportModelEntry[];
  isDuplicate?: boolean;
}

export interface ImportKey {
  keyName: string;
  keyValue: string;
  platform: string;
  baseUrl?: string;
  models?: ImportModelEntry[];
}

export interface PreviewResponse {
  keys: PreviewKey[];
  total: number;
  skipped: string[];
  duplicates: number;
}

export interface ImportSelectedRequest {
  keys: ImportKey[];
}

export interface ImportSelectedResponse {
  imported: number;
  skipped: string[];
  errors: Array<{ key: string; error: string }>;
  total: number;
  /** Models registered for imported custom endpoints (#382). */
  modelsRegistered: number;
}

// Active platforms — must match server/src/providers/index.ts and
// server/src/routes/keys.ts PLATFORMS allowlist.
// Moonshot and MiniMax direct integrations were dropped in migrateModelsV4
// (see server/src/db/index.ts). HuggingFace was dropped in V4 and re-added
// in V13 via the router.huggingface.co Inference Providers meta-router.
// SambaNova was dropped in V23 (free tier permanently retired — 402
// "payment method required" once the one-time $5 trial credit lapses).
export type Platform =
  | 'google'
  | 'groq'
  | 'cerebras'
  // Sail Research — native Responses API provider. $5 in free credits refreshes
  // monthly when a payment method is attached; usage beyond the grant is
  // pay-as-you-go. Background polling is required for its flex-only models.
  | 'sail'
  // B.AI — OpenAI-compatible gateway. Its catalog row is a live-tested,
  // limited-time 0-credit promotion, not a recurring free allowance.
  | 'bai'
  // AnyAPI — OpenAI-compatible gateway. Free tier is $0/no card/recurring but
  // capped at 100K tokens/day over "free and basic" models only; no RPM/RPD is
  // published. Catalog rows live in the hosted catalog (premium now, free after
  // 30 days).
  | 'anyapi'
  | 'nvidia'
  | 'mistral'
  | 'sambanova'
  | 'openrouter'
  | 'github'
  | 'cohere'
  | 'cloudflare'
  | 'zhipu'
  | 'ollama'
  | 'kilo'
  | 'pollinations'
  | 'llm7'
  | 'huggingface'
  // OpenCode Zen — OpenAI-compatible gateway. Free promotional models require a
  // free (no-card) account key from opencode.ai/auth; see migrateModelsV18.
  | 'opencode'
  // OVHcloud AI Endpoints — OpenAI-compatible, keyless anonymous tier
  // (2 req/min per IP per model); see migrateModelsV26.
  | 'ovh'
  // Agnes AI (Sapiens AI) — OpenAI-compatible (LiteLLM + vLLM backend). Serves
  // its own proprietary Agnes models; the free key comes from
  // platform.agnes-ai.com (no card).
  | 'agnes'
  // Reka — OpenAI-compatible. Native multimodal models (reka-edge takes
  // image/video); free via a recurring monthly credit grant, key from
  // platform.reka.ai (no card).
  | 'reka'
  // SiliconFlow — OpenAI-compatible. Registered for its FREE generative-media
  // models (FLUX.1-schnell image, CosyVoice2 TTS) routed via services/media.ts;
  // chat is supported too. Key from siliconflow.com (no card).
  | 'siliconflow'
  // Routeway — OpenAI-compatible aggregator. Free ':free' models ($0) on a
  // rate-limited pool (~5 rpm observed); requires a browser User-Agent (CF
  // blocks others). Key from routeway.ai (no card).
  | 'routeway'
  // BazaarLink — OpenAI-compatible aggregator. Free 'auto:free' route picks an
  // available zero-cost model. Key from bazaarlink.ai (no card).
  | 'bazaarlink'
  // AINative Studio — OpenAI-compatible aggregator. Advertises a recurring
  // ~10M tokens/month free allocation (no card); quota unverified. Key from
  // ainative.studio.
  | 'ainative'
  // Aion Labs — OpenAI-compatible aggregator with a no-card free API key.
  // Catalog rows live in the Oracle catalog (premium now, free after 30 days).
  | 'aion'
  // Requesty — OpenAI-compatible router with no-card free models/credits.
  // Catalog rows live in the Oracle catalog (premium now, free after 30 days).
  | 'requesty'
  // NavyAI — OpenAI-compatible unified API. Free plan is 150K tokens/day and
  // 20 RPM; catalog rows live in the Oracle catalog (premium now, free after 30 days).
  | 'navy'
  // NaraRouter — OpenAI-compatible aggregator. Free account key from
  // router.bynara.id after Telegram channel/link verification; free-plan routes
  // reset daily and are catalog-managed (premium now, free after 30 days).
  | 'nara'
  // SEA-LION (AI Singapore) — OpenAI-compatible first-party API. Free key
  // (Google sign-in, no card, no region wall) at 10 RPM; catalog rows live in
  // the Oracle catalog (premium now, free after 30 days).
  | 'sealion'
  // OrcaRouter — OpenAI-compatible aggregator (api.orcarouter.ai/v1). Free key
  // from orcarouter.ai (no card); recurring rate-limited free aliases at $0
  // (never fall back to paid). Catalog rows live in the Oracle catalog
  // (premium now, free after the 30-day model-age gate).
  | 'orcarouter'
  // UnoRouter (unorouter.com) — OpenAI-compatible aggregator. The web app is a
  // Next.js site at unorouter.com; the API lives at api.unorouter.com/v1. Free
  // key from unorouter.com (no card); free models carry a `:free` suffix and a
  // per-minute rate limit (429 on cap, e.g. "1 request(s) every 1 min").
  // Live-probed 2026-08-23: /v1/models is public without a key but 401s on a
  // wrong key, and /v1/chat/completions 401s without a key, so default key
  // validation works. Catalog rows live in the hosted catalog (premium now,
  // free after the 30-day model-age gate).
  | 'unorouter'
  // xKiro (xkiro.com) — OpenAI-compatible gateway at api.xkiro.com/v1. Free key
  // from xkiro.com (no card); free plan is 5M tokens/day on its free models,
  // paid models 403 on a free key.
  // /v1/models is public (200 with no key), so key validation must probe
  // /v1/usage, which 401s on a missing/invalid ClientApiKey. Catalog rows live
  // in the hosted catalog (premium now, free after the 30-day model-age gate).
  | 'xkiro'
  // ModelScope (魔搭社区, Alibaba) — OpenAI-compatible inference API
  // (api-inference.modelscope.cn/v1). Free tier is 2000 requests/day
  // account-wide, but calls only work after the ModelScope account is bound to
  // an Alibaba Cloud CHINA-site (cn) account with Chinese real-name
  // verification — tokens mint without binding, then every call 401s. Catalog
  // rows land after community testing confirms per-model behavior (#581).
  | 'modelscope'
  // ── Chinese domestic providers (#922/#923/#924) ────────────────────────────
  // All four need Chinese real-name verification (实名认证) on the cloud account
  // before a key will serve traffic, the same wall ModelScope hits above.
  // LongCat is the exception worth knowing: its platform accepts an email
  // signup from outside mainland China.
  //
  // Baidu Qianfan (百度千帆) — OpenAI-compatible (https://qianfan.baidubce.com/v2).
  // The ERNIE-Speed / ERNIE-Lite / ERNIE-Tiny series are free indefinitely via
  // pay-as-you-go billing rather than a token pool, so the ceiling is rate
  // limits, not a balance. Baidu calls the arrangement "long-term". Real-name
  // auth (individual or enterprise) required.
  | 'qianfan'
  // Volcengine Ark (火山方舟, ByteDance) — OpenAI-compatible
  // (https://ark.cn-beijing.volces.com/api/v3). Individual developers get a
  // RECURRING daily per-model free reward quota (raised from 500K to 2M
  // tokens/day/model), on top of a one-time 500K new-user grant. The strongest
  // recurring free tier of the four.
  | 'volcengine'
  // LongCat (Meituan / 美团) — OpenAI-compatible
  // (https://api.longcat.chat/openai/v1); also exposes an Anthropic-compatible
  // surface at /anthropic. Free tier is daily; the figure quoted at platform
  // launch was 100K tokens/day. Meituan has ANNOUNCED a 50M tokens/day
  // Flash-Lite free tier but it was described as a future plan, so it is not
  // treated as live here.
  | 'longcat'
  // iFlytek Spark (讯飞星火) — OpenAI-compatible
  // (https://spark-api-open.xf-yun.com/v1), Bearer auth using the console's
  // APIPassword (not the APIKey/APISecret pair the older WebSocket API used).
  // The Lite model (model id `lite`) is documented as free to call; iFlytek
  // does not publish a token ceiling or a QPS figure for it, so neither is
  // claimed here.
  | 'xfyun'
  // AI Horde — free, community-powered inference (volunteer workers) via an
  // OpenAI-compatible proxy (https://oai.aihorde.net/v1). Queue-based, so calls
  // can take tens of seconds; no tool support; usage is reported as kudos, not
  // tokens. Anonymous key `0000000000` works (lowest priority); a registered
  // aihorde.net key raises queue priority. Has a dedicated AIHordeProvider that
  // normalizes the proxy's OpenAI divergences. See issue #345.
  | 'aihorde'
  // User-configured OpenAI-compatible endpoint (llama.cpp, LM Studio, vLLM,
  // Ollama, any base_url). The endpoint URL lives on the api_keys row; see #117.
  | 'custom';

export interface Model {
  id: number;
  platform: Platform;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  rpmLimit: number | null;
  rpdLimit: number | null;
  tpmLimit: number | null;
  tpdLimit: number | null;
  monthlyTokenBudget: string;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
}

// ---- Quirks ----
// Structured, reusable notes about catalog models. One quirk is applied to many
// models via selector parameters (see quirk_targets / services/quirks.ts).
export type QuirkSeverity = 'info' | 'warning' | 'blocker';

export interface Quirk {
  slug: string;
  title: string;
  body: string;
  severity: QuirkSeverity;
}

export interface QuirkTarget {
  platform: Platform | null;
  modelGlob: string | null;
}

export interface ModelListRow {
  platform: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  // 1 when the catalog row is enabled. 1 when an enabled key can serve it
  // (enabled AND a matching enabled api_key exists). SQLite returns 0/1.
  enabled: number;
  available: number;
}

export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';

export interface ApiKeyModel {
  id: number;
  kind: 'chat' | 'embedding' | 'image' | 'audio' | 'transcription';
  modelId: string;
  displayName: string;
  family?: string | null;
}

/** An active rate-limit cooldown on one model for a key. A key can be healthy
 *  and enabled yet still skipped by the router because of these. */
export interface ApiKeyCooldown {
  modelId: string;
  expiresAtMs: number;
  remainingMs: number;
}

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  baseUrl: string | null;
  status: KeyStatus;
  enabled: boolean;
  keyless: boolean;
  /** Whether an export file would actually contain this row. The server decides
   *  it so the dialog's "will export N keys" cannot drift from the export. */
  exportable: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  lastHealthError: string | null;
  /** Model ids this key is limited to; null = serves every model of its
   *  platform (#657). */
  modelScope?: string[] | null;
  models?: ApiKeyModel[];
  cooldowns?: ApiKeyCooldown[];
}

export interface ApiKeyCreate {
  platform: Platform;
  key: string;
  label?: string;
}

// ---- Fallback Config ----

export interface FallbackEntry {
  modelId: number;
  platform: Platform;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  priority: number;
  enabled: boolean;
  // Present when model unification is enabled — identifies the logical model
  // this provider row belongs to so the dashboard can render grouped rows.
  groupKey?: string;
  canonicalId?: string;
  groupLabel?: string;
}

// ---- Model Grouping (unify the same model across providers) ----
// One logical model can be served by several providers (rows in the `models`
// table). When unification is enabled, those rows collapse into a single group
// keyed by a normalized display name; see server/src/services/model-groups.ts.
export interface ModelGroupInfo {
  groupKey: string;     // normalized display name — the grouping identity
  canonicalId: string;  // stable slug advertised on /v1/models
  groupLabel: string;   // human label (suffix-stripped display name)
}

export interface UnifyOverrides {
  // Coalesce several normalized display-names (or exact "platform:model_id"
  // members) into one group keyed by `into`.
  merges: { into: string; keys: string[] }[];
  // Force a specific "platform:model_id" row out of its computed group.
  splits: { member: string; groupKey?: string }[];
}

export interface UnifySettings {
  enabled: boolean;
  overrides: UnifyOverrides;
}

// ---- OpenAI-Compatible Types ----

export interface ChatToolCallFunction {
  name: string;
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: ChatToolCallFunction;
  thought_signature?: string;
}

export interface ChatToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatToolDefinition {
  type: 'function';
  function: ChatToolFunctionDefinition;
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | {
    type: 'function';
    function: {
      name: string;
    };
  };

// OpenAI's multimodal envelope: clients like opencode / continue.dev send
// content as an array of typed blocks even for text-only messages, and
// Gemini-lineage agents (Qwen Code, AionUI) send part-style `{ text }` blocks
// with no `type` — plus bare strings inside arrays. We accept all of it on
// the wire and flatten to string for providers that don't support arrays
// (Cohere, Cloudflare). See server/src/lib/content.ts. (#200)
export type ChatContentBlock = string | { type?: string; text?: string; [key: string]: unknown };
export type ChatContent = string | null | ChatContentBlock[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatContent;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  // The model's thinking trace on an assistant turn. Some thinking models
  // (DeepSeek on OpenCode Zen) require it to be replayed verbatim on the next
  // turn or they 400; the proxy preserves and forwards it. See issue #255.
  reasoning_content?: string;
  // Moonshot's "partial" prefill flag on an assistant turn: when true, the
  // model continues the given text instead of starting a fresh turn. Only
  // forwarded to models that understand it (Moonshot/Kimi); stripped for all
  // other providers. See issue #1038.
  partial?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  top_p?: number;
  stop?: string | string[];
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
  // Present when the client requested logprobs and the provider returned
  // them; passed through verbatim (provider shapes vary slightly).
  logprobs?: unknown;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // OpenAI-standard breakdown some providers advertise alongside the totals.
  // Optional because many free-tier endpoints omit it; the proxy falls back
  // to its chars/4 estimate when absent. (#764)
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  // Gateway-synthesized block (upstream never sent usage): flagged so a
  // cost-accounting client can tell it apart from the upstream's real
  // counts. (#1084)
  estimated?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  _routed_via?: {
    platform: Platform;
    model: string;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
  usage?: TokenUsage;
}

// ---- Analytics Types ----

export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  estimatedCostSavings: number;
}

export interface PlatformStats {
  platform: Platform;
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TimelinePoint {
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
}

export interface RequestLog {
  id: number;
  platform: Platform;
  modelId: string;
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- Rate Limit Types ----

export interface RateLimitStatus {
  platform: Platform;
  modelId: string;
  rpm: { used: number; limit: number | null };
  rpd: { used: number; limit: number | null };
  tpm: { used: number; limit: number | null };
  available: boolean;
  nextResetAt: string | null;
}

// ---- Provider Quota Observability ----

export type QuotaMetric = 'requests' | 'tokens' | 'credits' | 'neurons';
export type QuotaResetStrategy = 'fixed_calendar' | 'rolling_window' | 'token_bucket' | 'provider_reported' | 'unknown';
export type QuotaObservationSource = 'header' | 'quota_api' | 'error_body' | 'local_usage' | 'documentation' | 'probe';

export interface ProviderQuotaState {
  platform: Platform;
  keyId: number;
  /** The key's operator-facing label, when the row still names a live key. */
  keyLabel?: string | null;
  quotaPoolKey: string;
  metric: QuotaMetric;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  resetStrategy: QuotaResetStrategy;
  source: QuotaObservationSource;
  confidence: number;
  notes: string | null;
  observedAt: string;
  updatedAt: string;
}

export interface ProviderQuotaObservation extends ProviderQuotaState {
  id: string;
  statusCode: number | null;
  retryAfterMs: number | null;
  providerAccountId: string | null;
  modelId: string | null;
  endpoint: string | null;
  rawJson: string | null;
  createdAt: string;
}
