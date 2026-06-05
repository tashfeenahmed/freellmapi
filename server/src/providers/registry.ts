export type ProviderRegistryEntry = {
  slug: string;
  displayName: string;
  baseUrl: string;
  modelListEndpoint?: string;
  supportsMultipleAccounts: boolean;
  authType: 'bearer' | 'keyless' | 'custom';
  openAICompatible: boolean;
  defaultHeaders?: Record<string, string>;
  rateLimitStrategy: 'model' | 'account' | 'provider' | 'unknown';
};

export const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  { slug: 'google', displayName: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: false, rateLimitStrategy: 'account' },
  { slug: 'groq', displayName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'cerebras', displayName: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'sambanova', displayName: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'nvidia', displayName: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'mistral', displayName: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'openrouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, defaultHeaders: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' }, rateLimitStrategy: 'account' },
  { slug: 'github', displayName: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'cohere', displayName: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'cloudflare', displayName: 'Cloudflare Workers AI', baseUrl: '', supportsMultipleAccounts: true, authType: 'custom', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'zhipu', displayName: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'huggingface', displayName: 'HuggingFace Router', baseUrl: 'https://router.huggingface.co/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'ollama', displayName: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'kilo', displayName: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway/v1', modelListEndpoint: 'https://api.kilo.ai/api/gateway/models', supportsMultipleAccounts: false, authType: 'keyless', openAICompatible: true, rateLimitStrategy: 'provider' },
  { slug: 'pollinations', displayName: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai/v1', modelListEndpoint: '/models', supportsMultipleAccounts: false, authType: 'keyless', openAICompatible: true, rateLimitStrategy: 'provider' },
  { slug: 'llm7', displayName: 'LLM7', baseUrl: 'https://api.llm7.io/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'opencode', displayName: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'bearer', openAICompatible: true, rateLimitStrategy: 'account' },
  { slug: 'custom', displayName: 'Custom OpenAI-compatible', baseUrl: '', modelListEndpoint: '/models', supportsMultipleAccounts: true, authType: 'custom', openAICompatible: true, rateLimitStrategy: 'unknown' },
];

export function getProviderRegistryEntry(slug: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.slug === slug);
}
