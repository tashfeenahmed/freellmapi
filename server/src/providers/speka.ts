import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const SPEKA_BASE_URL = 'https://speka.me/v1';
const VALIDATION_MODEL = '__freellmapi_key_validation__';

/** OpenAI-compatible chat; model rows are delivered only by the signed catalog.
 * Free's $1/month is shared across chat and embeddings, not a per-model grant.
 * Docs: https://speka.me/docs and https://speka.me/pricing. */
export class SpekaProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'speka', name: 'Speka', baseUrl: SPEKA_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // /models is public, so a 200 there does not validate a key. Speka checks
    // authentication before resolving a model: this deliberately nonexistent
    // model returns 400/model_not_found only after auth, without generating
    // tokens. Verified against both a valid key and an invalid-key control.
    const res = await this.fetchWithTimeout(`${SPEKA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: VALIDATION_MODEL, messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
    }, providerTimeoutMs('speka', 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: 'speka', endpoint: 'key-validation' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (res.status === 400) {
      const body = await res.clone().json().catch(() => null) as { error?: { type?: string } } | null;
      if (body?.error?.type === 'model_not_found') return true;
    }
    // Rate limits, exhausted allowances, malformed responses and outages are
    // inconclusive, not proof that a key is valid or invalid.
    throw providerHttpError(res, 'Speka key validation is temporarily inconclusive');
  }
}
