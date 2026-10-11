import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type KeyValidationResult } from './base.js';

// Tavily is a search API, not a chat provider (#1174). Its key lives in the
// normal api_keys pool and is consumed by services/search.ts via POST /v1/search;
// the chat surface exists only so the key can be registered and validated like
// every other platform. A chat request to a Tavily key is a routing mistake and
// is rejected with a clear 422 rather than mis-served.

const API_BASE = 'https://api.tavily.com';

export class TavilyProvider extends BaseProvider {
  readonly platform: Platform = 'tavily';
  readonly name = 'Tavily';

  async chatCompletion(_apiKey: string, _messages: ChatMessage[], _modelId: string, _options?: CompletionOptions): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Tavily is a search provider: its key serves POST /v1/search, not chat completions'), { status: 422 });
  }

  // eslint-disable-next-line require-yield -- a rejected async iterator: the throw surfaces on first next()
  async *streamChatCompletion(_apiKey: string, _messages: ChatMessage[], _modelId: string, _options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Tavily is a search provider: its key serves POST /v1/search, not chat completions'), { status: 422 });
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    // Tavily has no cheap "who am I" endpoint; a minimal search probe is the
    // cheapest truth. 400 with a usage-cap error still proves the key parsed.
    const res = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: 'ping', max_results: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return { valid: false, error: `Tavily key validation failed (HTTP ${res.status}): invalid key` };
    // 432 = Tavily usage cap; 4xx others (e.g. malformed body) still prove auth.
    if (res.status >= 400 && res.status < 500) return true;
    return { valid: false, error: `Tavily key validation inconclusive (HTTP ${res.status})` };
  }
}
