import type { ChatMessage } from '@freellmapi/shared/types.js';

export const HANDOFF_MAX_TOKENS = 0;

export function getContextHandoffMode(): 'off' {
  return 'off';
}

export function recordIncomingMessages(_sessionKey: string, _messages: ChatMessage[]): void {}

export function maybeInjectContextHandoff(opts: {
  mode: 'off';
  sessionKey: string;
  messages: ChatMessage[];
  selectedModelKey: string;
}): { injected: false; injectedTokens: 0; messages: ChatMessage[] } {
  return { injected: false, injectedTokens: 0, messages: opts.messages };
}

export function recordSuccessfulModel(_opts: { sessionKey: string; modelKey: string }): void {}

export function hasPriorModel(_sessionKey: string): boolean {
  return false;
}
