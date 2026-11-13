import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';
import { proxyFetch } from '../lib/proxy.js';

export const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1';

/** Brave answers a bad key with 422 (not 401) and this error code; a 422 with
 *  any other code (VALIDATION) is a bad parameter and the key is fine. */
export const BRAVE_BAD_KEY_CODE = 'SUBSCRIPTION_TOKEN_INVALID';

// Brave Search API (brave.com/search/api). The key rides in X-Subscription-Token.
// Brave bills only successful requests, so the key check is a web search with
// no `q`: free, and the 422 it earns says which half failed. It is still an
// empty search, so (like Exa, #1599) the health pass sends it once per key.
export class BraveProvider extends SearchOnlyProvider {
  readonly platform = 'brave' as const;
  readonly name = 'Brave Search';

  override get supportsKeyPolling(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    let res: Response;
    try {
      res = await proxyFetch(`${BRAVE_BASE_URL}/web/search`, {
        method: 'GET',
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      }, this.platform, 'search', 10_000);
    } catch (err) {
      return { valid: false, error: `${this.name} key validation inconclusive: ${err instanceof Error ? err.message : String(err)}` };
    }
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403 || body.includes(BRAVE_BAD_KEY_CODE)) {
      return { valid: false, error: `${this.name} key validation failed (HTTP ${res.status}): invalid API key` };
    }
    if (res.ok || (res.status >= 400 && res.status < 500)) return true;
    return { valid: false, error: `${this.name} key validation inconclusive (HTTP ${res.status})` };
  }
}
