// GLIXEL's AI paths. Each answer comes from exactly one path, chosen
// explicitly by the user; one path never silently falls back to another.
//
// 'freellmapi' is the default and only working path: the shared inbound-chat
// pipeline with automatic routing and the free-only guard.
//
// 'claude' is declared so the app and API can offer the choice honestly, but it
// is unavailable: FreeLLMAPI has no Anthropic provider adapter. Registering
// Anthropic as a 'custom' OpenAI-compatible endpoint is not a safe substitute,
// because opting 'custom' into free-only routing would make a paid model
// eligible for automatic routing, so requests could be billed silently. A real
// Claude path needs a dedicated server-side adapter, an Anthropic API key
// (billed separately from any Claude.ai subscription) stored through the
// existing encrypted key storage, and exclusion from automatic routing.
export type GlixelProviderId = 'freellmapi' | 'claude';
export const GLIXEL_PROVIDER_IDS = ['freellmapi', 'claude'] as const;
export const GLIXEL_DEFAULT_PROVIDER: GlixelProviderId = 'freellmapi';

export interface GlixelProviderStatus {
  id: GlixelProviderId;
  label: string;
  available: boolean;
  // What the path costs: FreeLLMAPI follows the server's free-only setting.
  billing: 'free models only' | 'free-only routing is off' | 'paid API';
  reason: string | null;
}

export const CLAUDE_UNAVAILABLE_REASON =
  'Claude is not connected. FreeLLMAPI has no Anthropic provider yet, and GLIXEL will not reach Claude through ' +
  'a workaround that could bill you without asking. Connecting Claude needs an Anthropic API key (billed ' +
  'separately from a Claude.ai subscription) and a dedicated server-side adapter.';

export function glixelProviders(freeOnlyEnabled: boolean): GlixelProviderStatus[] {
  return [
    { id: 'freellmapi', label: 'FreeLLMAPI', available: true, billing: freeOnlyEnabled ? 'free models only' : 'free-only routing is off', reason: null },
    { id: 'claude', label: 'Claude', available: false, billing: 'paid API', reason: CLAUDE_UNAVAILABLE_REASON },
  ];
}
