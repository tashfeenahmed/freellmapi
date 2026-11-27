import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai/';
export const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai/';

// TinyFish (tinyfish.ai): web search with an X-API-Key header. Search is free
// at any wallet balance and does not draw wallet funds; limits are 30 requests
// a minute and 500 an hour (docs, and x-ratelimit-limit: 30 live on
// 2026-11-23).
//
// There is no account endpoint. The key check posts an empty URL list to the
// Fetch API, which checks auth first: a bad key gets 401 INVALID_API_KEY and a
// good key gets 400 (urls must have at least one item). Nothing is fetched or
// searched, but it is a malformed request, so the health pass sends it once
// per key (rule 3 of the provider guide).
export class TinyFishProvider extends SearchOnlyProvider {
  readonly platform = 'tinyfish' as const;
  readonly name = 'TinyFish';

  override get supportsKeyPolling(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(TINYFISH_FETCH_URL, {
      method: 'POST',
      redirect: 'error',
      headers: { 'X-API-Key': apiKey.trim(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ urls: [] }),
    });
  }
}
