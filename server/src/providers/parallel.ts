import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';
import { isAnonymousCredential } from '../lib/credential.js';

export const PARALLEL_BASE_URL = 'https://api.parallel.ai/v1';
export const PARALLEL_MCP_URL = 'https://search.parallel.ai/mcp';

// Parallel (parallel.ai): keyless web search. The Search MCP server answers
// anonymous `tools/call web_search` requests with no account, rate-limited per
// caller, so the Keys page stores the `no-key` sentinel and search runs over
// MCP. A real API key (free signup credits) switches to the REST Search API,
// which has published, higher limits.
//
// Validation spends nothing either way: the sentinel is checked with an MCP
// `initialize`, and a real key with an empty POST /v1/search, which a valid key
// answers 422 (no search_queries) and a bad one 401.
export class ParallelProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'parallel';
  readonly name = 'Parallel';
  keyless = true;

  /** #1599: validation is an empty search, so the health pass checks a key
   * once instead of every few minutes. */
  override get supportsKeyPolling(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (isAnonymousCredential(apiKey)) {
      return this.probe(PARALLEL_MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'freellmapi', version: '1' } },
        }),
      });
    }
    return this.probe(`${PARALLEL_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim(), 'Content-Type': 'application/json' },
      body: '{}',
    });
  }
}
