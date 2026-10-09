import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const DAHL_ORIGIN = 'https://inference.dahl.global';
export const DAHL_BASE_URL = `${DAHL_ORIGIN}/v1`;
export const DAHL_BALANCE_URL = `${DAHL_ORIGIN}/tokens/current`;

/** Gonka DAHL: OpenAI-compatible chat served by the Gonka network. A new
 * account gets a one-time 100M-token welcome grant in its pool (username only,
 * no card); the user allocates pool tokens to a key before it can serve.
 * Model rows arrive only through the signed catalog.
 * https://inference.dahl.global/docs/tokens/ */
export class DahlProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'dahl',
      name: 'Gonka DAHL',
      baseUrl: DAHL_BASE_URL,
      // Tokens allocated to this key only; the account pool is not visible
      // to a Bearer key, so there is no limit to report.
      quotaProbe: {
        url: DAHL_BALANCE_URL,
        metric: 'tokens',
        limitFields: [],
        remainingFields: ['available_tokens'],
        notes: 'dahl key balance: tokens allocated to this key (account pool excluded)',
      },
    });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // /v1/models is public, so a 200 there does not validate a key. The
    // balance endpoint is authenticated and runs no inference: live controls
    // returned 401 invalid_api_key for a missing or wrong key and
    // 200 {"available_tokens": <int>} for a real one.
    const res = await this.fetchWithTimeout(DAHL_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, providerTimeoutMs('dahl', 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: 'dahl', endpoint: 'key-validation' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (res.ok) {
      const body = await res.clone().json().catch(() => null) as { available_tokens?: unknown } | null;
      if (typeof body?.available_tokens === 'number') return true;
    }
    // Outages, rate limits and unexpected bodies say nothing about the key.
    throw providerHttpError(res, 'Gonka DAHL key validation is temporarily inconclusive');
  }
}
