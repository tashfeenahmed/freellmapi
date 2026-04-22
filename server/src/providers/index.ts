import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { HuggingFaceProvider } from './huggingface.js';

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

// SambaNova - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'sambanova',
  name: 'SambaNova',
  baseUrl: 'https://api.sambanova.ai/v1',
}));

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

// GitHub Models - OpenAI-compatible via Azure endpoint
register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.inference.ai.azure.com',
}));

// Cohere - OpenAI-compatible via Cohere compatibility endpoint
register(new CohereProvider());

// Cloudflare Workers AI - OpenAI-compatible endpoint (key = "account_id:token")
register(new CloudflareProvider());

// Hugging Face - OpenAI-compatible per-model endpoint
register(new HuggingFaceProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
}));

// Moonshot (Kimi) - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'moonshot',
  name: 'Moonshot',
  baseUrl: 'https://api.moonshot.ai/v1',
}));

// MiniMax - OpenAI-compatible
register(new OpenAICompatProvider({
  platform: 'minimax',
  name: 'MiniMax',
  baseUrl: 'https://api.minimax.io/v1',
}));

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
