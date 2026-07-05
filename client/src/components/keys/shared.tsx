import type { ApiKeyModel, Platform, ProviderQuotaState } from '../../../../shared/types'
import { ExternalLink } from 'lucide-react'
import { useI18n } from '@/i18n'

// Small "Get API key" external link shown next to a provider (#137).
export function GetKeyLink({ url }: { url: string }) {
  const { t } = useI18n()
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {t('keys.getApiKey')}
      <ExternalLink className="size-3" />
    </a>
  )
}

// `url` points to each provider's key-management / signup page so the Keys page
// can show a "Get API key" shortcut (#137). OpenCode Zen's key is free from
// opencode.ai/auth — no card needed; billing only applies to paid models (#128).
// `keyless: true` providers (Kilo's anonymous free tier) need no API key — the
// form disables the key field and submits a sentinel the backend stores so
// routing treats the platform as configured.
export const PLATFORMS: { value: Platform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', url: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { value: 'nvidia', label: 'NVIDIA NIM', url: 'https://build.nvidia.com/settings/api-keys' },
  { value: 'mistral', label: 'Mistral', url: 'https://console.mistral.ai/api-keys/' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { value: 'cohere', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', url: 'https://z.ai/manage-apikey/apikey-list' },
  { value: 'ollama', label: 'Ollama Cloud', url: 'https://ollama.com/settings/keys' },
  { value: 'kilo', label: 'Kilo Gateway (no key needed)', url: 'https://app.kilo.ai', keyless: true },
  { value: 'pollinations', label: 'Pollinations (no key needed)', url: 'https://pollinations.ai', keyless: true },
  { value: 'ovh', label: 'OVH AI Endpoints (no key needed)', url: 'https://endpoints.ai.cloud.ovh.net', keyless: true },
  { value: 'llm7', label: 'LLM7 (anon ok)', url: 'https://llm7.io' },
  { value: 'huggingface', label: 'HuggingFace Router', url: 'https://huggingface.co/settings/tokens' },
  { value: 'opencode', label: 'OpenCode Zen (free key)', url: 'https://opencode.ai/auth' },
  { value: 'agnes', label: 'Agnes AI (free key)', url: 'https://platform.agnes-ai.com' },
  { value: 'reka', label: 'Reka (free key)', url: 'https://platform.reka.ai' },
  { value: 'siliconflow', label: 'SiliconFlow (image + TTS)', url: 'https://siliconflow.com' },
  { value: 'routeway', label: 'Routeway (free key)', url: 'https://routeway.ai' },
  { value: 'bazaarlink', label: 'BazaarLink (free key)', url: 'https://bazaarlink.ai' },
  { value: 'ainative', label: 'AINative Studio (free key)', url: 'https://ainative.studio' },
  { value: 'aihorde', label: 'AI Horde (no key needed, slow)', url: 'https://aihorde.net/register', keyless: true },
]

// 'custom' is configured through its own form (base URL + model), not the
// generic key dropdown — but it still appears in the grouped provider list.
export const CUSTOM_GROUP: { value: Platform; label: string; url: string } = {
  value: 'custom',
  label: 'Custom (OpenAI-compatible)',
  url: '',
}

export const CUSTOM_MODEL_KIND_LABEL: Record<ApiKeyModel['kind'], string> = {
  chat: 'keys.customTypeChat',
  embedding: 'keys.customTypeEmbedding',
  image: 'keys.customTypeImage',
  audio: 'keys.customTypeAudio',
}

export function customModelDeleteKey(model: ApiKeyModel): string {
  return `${model.kind}:${model.id}`
}

export function customModelDeletePath(model: ApiKeyModel): string {
  if (model.kind === 'chat') return `/api/models/custom/${model.id}`
  if (model.kind === 'embedding') return `/api/embeddings/custom/${model.id}`
  return `/api/media/custom/${model.id}`
}

export const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

export const statusLabelKey: Record<string, string> = {
  healthy: 'status.healthy',
  rate_limited: 'status.rateLimited',
  invalid: 'status.invalid',
  error: 'status.error',
  unknown: 'status.unchecked',
}

export interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

export interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
  quotaStates: ProviderQuotaState[]
}
