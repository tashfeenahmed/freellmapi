import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

// Google - unique Gemini API format
register(new GoogleProvider());

// Groq - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
}));

// Cerebras - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova was dropped in V23 (June 2026): the free tier is permanently gone.
// The always-free tier was retired in early 2025 for a one-time $5 trial
// credit (expires in 3 months); once it lapses, every chat call 402s
// "payment method required" with no recurring no-card path back.

// NVIDIA NIM - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
}));

// Mistral - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
}));

// OpenRouter - OpenAI-compatible with extra headers
register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-Title': 'FreeLLMAPI',
  },
}));

// GitHub Models — OpenAI-compatible. Catalog uses `<publisher>/<model>` ids
// (e.g. `openai/gpt-4.1`); the old Azure endpoint rejects that prefix with
// "Unknown model", so route to the current models.github.ai endpoint.
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.github.ai/inference',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
}));

// Hugging Face Inference Providers router — re-added in V13. The V4 removal
// reason ("tool-call format issues") was the legacy serverless route that
// emitted tool calls as text; the new router.huggingface.co meta-router
// uses each backend's native protocol then normalizes the response.
// Recurring $0.10/mo router credit on the free tier, no card required.
register(new OpenAICompatProvider({
  platform: 'huggingface',
  name: 'HuggingFace Router',
  baseUrl: 'https://router.huggingface.co/v1',
}));

// Moonshot direct integration was dropped in V4 (paid-only); MiniMax direct
// was dropped in V4 (superseded by the OpenRouter route).

// Ollama Cloud — OpenAI-compatible. Free plan: 1 concurrent model, 5h session
// caps, GPU-time-based quota (not per-token). Many catalog models on the
// /v1/models list are subscription-only — Free returns 403 with an explicit
// "this model requires a subscription" message. Catalog rows are filtered to
// confirmed-Free entries.
//
// Frontier reasoning models (glm-4.7, kimi-k2-thinking, cogito-2.1:671b)
// regularly take 30-90s on Ollama Cloud Free, so the timeout is bumped from
// the default 15s. Ollama returns reasoning in `message.reasoning` (not
// `reasoning_content`) — handled by normalizeChoices.
register(new OpenAICompatProvider({
  platform: 'ollama',
  name: 'Ollama Cloud',
  baseUrl: 'https://ollama.com/v1',
  timeoutMs: 120000,
}));

// Kilo AI Gateway — OpenAI-compatible aggregator. Kilo documents anonymous
// (keyless) access for `:free` routes, rate-limited 200 req/hr per IP — so this
// is registered `keyless: true`: the provider omits the Authorization header and
// the Keys page stores a sentinel row so routing treats it as configured. Free
// prompts/outputs are logged for training. validateUrl points at the gateway's
// real model list (`/api/gateway/models`, no `/v1`) which answers GET keyless;
// the `/v1/models` path only accepts POST (405). Probe before adding catalog
// rows — most named "free" routes eventually transition to paid.
register(new OpenAICompatProvider({
  platform: 'kilo',
  name: 'Kilo Gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway/v1',
  validateUrl: 'https://api.kilo.ai/api/gateway/models',
  keyless: true,
}));

// Pollinations — OpenAI-compatible, anonymous tier. The chat completions
// endpoint lives at `/openai/v1/chat/completions` (NOT `/v1/...` — the
// `/openai` prefix is mandatory). Public model list returns one anonymous
// model (`openai-fast` = GPT-OSS 20B on OVH, tools=true).
register(new OpenAICompatProvider({
  platform: 'pollinations',
  name: 'Pollinations',
  baseUrl: 'https://text.pollinations.ai/openai/v1',
}));

// LLM7.io — OpenAI-compatible aggregator. 100 req/hr free; anonymous access
// also works for basic models. Wraps a handful of upstream models behind one
// token (GPT-OSS, Llama 3.1 Turbo via Meta, Codestral via Mistral, Ministral,
// GLM-4.6V-Flash).
register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
}));

// OpenCode Zen — OpenAI-compatible gateway (https://opencode.ai/zen/v1), same
// adapter as Groq/OpenRouter. A handful of promotional models are free for a
// limited time; they need a free account key from https://opencode.ai/auth
// (no card required — billing only applies to paid models). The free roster is
// trial-only and prompts/outputs may be used to improve the models, so we seed
// just the docs-confirmed free IDs (migrateModelsV18) with conservative limits.
register(new OpenAICompatProvider({
  platform: 'opencode',
  name: 'OpenCode Zen',
  baseUrl: 'https://opencode.ai/zen/v1',
}));

// Chutes was evaluated for V11 and dropped: probe with a free-tier key
// returned 402 on every model — "Quota exceeded and account balance is
// $0.0, please pay with fiat or send tao". The "free" tier requires a
// non-zero balance, which conflicts with the project's no-card criterion.

// Placeholder so getProvider('custom')/hasProvider('custom')/getAllProviders()
// behave — but the real instance is built per-key by resolveProvider(), since
// a custom provider's base URL is user-supplied and lives on the api_keys row.
register(new OpenAICompatProvider({
  platform: 'custom',
  name: 'Custom (OpenAI-compatible)',
  baseUrl: '',
}));

// Locally-hosted inference (llama.cpp / vLLM / Ollama on CPU) can be slow, so
// custom providers get the same extended timeout as Ollama Cloud.
const CUSTOM_PROVIDER_TIMEOUT_MS = 120000;

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

/**
 * Resolve the provider for a route. Built-in platforms return their registered
 * singleton; the 'custom' platform builds a fresh OpenAICompatProvider bound to
 * the caller-supplied base URL (stored per api_keys row). Returns undefined for
 * a custom provider with no base URL configured.
 */
export function resolveProvider(platform: Platform, baseUrl?: string | null): BaseProvider | undefined {
  if (platform === 'custom') {
    const trimmed = baseUrl?.trim();
    if (!trimmed) return undefined;
    return new OpenAICompatProvider({
      platform: 'custom',
      name: 'Custom (OpenAI-compatible)',
      baseUrl: trimmed,
      timeoutMs: CUSTOM_PROVIDER_TIMEOUT_MS,
    });
  }
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
