import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const TYPHOON_BASE_URL = 'https://api.opentyphoon.ai/v1';

/** Ongoing free, rate-limited research API, not a monthly credit grant.
 * Model rows arrive only through the signed catalog; OCR is not included.
 * https://docs.opentyphoon.ai/en/faq/ */
export class TyphoonProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'typhoon', name: 'Typhoon', baseUrl: TYPHOON_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // /models is public. Live controls returned 401 for an invalid key, 403
    // without a key, and this exact 400 only after successful authentication.
    // The nonexistent model avoids consuming inference tokens during checks.
    const res = await this.fetchWithTimeout(`${TYPHOON_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '__freellmapi_key_validation__', messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
    }, providerTimeoutMs('typhoon', 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: 'typhoon', endpoint: 'key-validation' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (res.status === 400) {
      const body = await res.clone().json().catch(() => null) as { detail?: unknown } | null;
      if (body?.detail === 'Model not found') return true;
    }
    throw providerHttpError(res, 'Typhoon key validation is temporarily inconclusive');
  }
}
