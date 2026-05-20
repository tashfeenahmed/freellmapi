export const PLATFORMS = [
  'google',
  'groq',
  'cerebras',
  'sambanova',
  'nvidia',
  'mistral',
  'openrouter',
  'github',
  'cohere',
  'cloudflare',
  'zhipu',
  'ollama',
  'kilo',
  'pollinations',
  'llm7',
] as const;

export type Platform = typeof PLATFORMS[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}
