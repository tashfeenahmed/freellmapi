import type { KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const BASE_URL = 'https://api.router9.com/v1';

/** Router9's public /models returns 200 even for a bogus key. Authenticate
 * with a deliberately incomplete chat request instead: no model or prompt
 * can reach inference. Verified 2026-09-10: invalid keys get 401; a valid key
 * gets 404 model_not_found PLUS account credit headers. This consumes one
 * request from the provider's burst allowance, but no inference credits.
 *
 * The inherited adapter already splits inline <think> blocks and accepts
 * streams ending at EOF after finish_reason (Router9 omits [DONE]). */
export class Router9Provider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'router9', name: 'Router9', baseUrl: BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    }, 30_000, { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform, keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId, quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions:auth-probe',
    });
    if (res.status === 401) return this.validationResult(res);

    const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
    const accountHeaders = ['x-credits-limit', 'x-credits-remaining'].every(name => {
      const value = res.headers.get(name);
      return value !== null && value.trim() !== '' && Number.isFinite(Number(value));
    });
    // A generic 404/429 from a proxy or public route is not authentication.
    // Account headers are required; quota exhaustion does not revoke a key.
    if (accountHeaders && (
      (res.status === 404 && body?.error?.code === 'model_not_found') ||
      res.status === 402 || res.status === 429
    )) return true;
    throw new Error(`Router9 key validation inconclusive (HTTP ${res.status}); no authenticated probe verdict`);
  }
}
