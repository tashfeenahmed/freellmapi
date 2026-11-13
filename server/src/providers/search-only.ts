import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type KeyValidationResult } from './base.js';
import { proxyFetch } from '../lib/proxy.js';

// Base for web search APIs (#1174). Their keys live in the normal api_keys
// pool so they register, validate and show health like every other platform,
// but they are consumed only by services/search.ts (POST /v1/search and the
// agents' web_search tools). They never get chat rows, so the chat router
// cannot pick them; a chat call that still reaches one is a routing mistake
// and is refused with a 422 rather than mis-served.

const VALIDATE_TIMEOUT_MS = 10_000;

export abstract class SearchOnlyProvider extends BaseProvider {
  private chatRefusal(): Error {
    return Object.assign(
      new Error(`${this.name} is a search provider: its key serves POST /v1/search, not chat completions`),
      { status: 422 },
    );
  }

  async chatCompletion(_apiKey: string, _messages: ChatMessage[], _modelId: string, _options?: CompletionOptions): Promise<ChatCompletionResponse> {
    throw this.chatRefusal();
  }

  // eslint-disable-next-line require-yield -- a rejected async iterator: the throw surfaces on first next()
  async *streamChatCompletion(_apiKey: string, _messages: ChatMessage[], _modelId: string, _options?: CompletionOptions): AsyncGenerator<ChatCompletionChunk> {
    throw this.chatRefusal();
  }

  /** Shared verdict for a validation probe: 401/403 is a bad key, any other
   *  4xx (usage cap, out of credits, malformed probe) still proves the key
   *  authenticated, and 5xx/transport failures are inconclusive.
   *
   *  Inconclusive cases **throw**, matching #1298's contract and every other
   *  provider (pollinations, kenari, llmtr, google): the health service only
   *  treats a thrown validation as `error`; a returned `{valid:false}` is
   *  recorded as `invalid` and — because disabled keys are skipped by later
   *  passes — permanently benches a working key. A 10 s timeout on a search
   *  call is evidence about the network, not about the key (#1717). */
  protected async probe(url: string, init: RequestInit): Promise<KeyValidationResult> {
    let res: Response;
    try {
      res = await proxyFetch(url, { ...init, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) }, this.platform, 'search', VALIDATE_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`${this.name} key validation inconclusive: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: `${this.name} key validation failed (HTTP ${res.status}): invalid API key` };
    }
    if (res.status >= 400 && res.status < 500) return true;
    throw new Error(`${this.name} key validation inconclusive (HTTP ${res.status})`);
  }
}
