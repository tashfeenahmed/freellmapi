// ---- Platform & Model Types ----

export interface PreviewKey {
  keyName: string;
  keyValue: string;
  detectedPlatform: string | null;
  prefix: string;
  isDuplicate?: boolean;
}

export interface ImportKey {
  keyName: string;
  keyValue: string;
  platform: string;
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
  kind: 'chat' | 'embedding' | 'image' | 'audio';
  modelId: string;
  displayName: string;
  family?: string | null;
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
  createdAt: string;
  lastCheckedAt: string | null;
  models?: ApiKeyModel[];
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
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
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
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string | null;
  }[];
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
