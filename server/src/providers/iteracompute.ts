import type { KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const ITERACOMPUTE_BASE_URL = 'https://api.iteracompute.com/v1';

/**
 * IteraCompute (#1649): an OpenAI-compatible gateway whose free tier is one
 * account-wide monthly TOKEN allowance — 30M tokens (input + output, reasoning
 * included) per account, 160,000 TPM, resetting at 00:00 UTC on the 1st with
 * no rollover and no paid overage (free-tier terms, Oct 2026). The free model
 * published today is `qwen/qwen3.8-27b` (`is_free: true`, zero prices on the
 * public model list; the paid rows share the key, so the 30-day free gate and
 * the signed catalog decide what actually routes here).
 *
 * Key validation is deliberately OFF (mirrors freeai #1459): `GET /models` is
 * anonymous — a bogus `Authorization` header still returns 200 (verified live
 * 2026-10-22) — and the only authenticated endpoint is `/chat/completions`,
 * which reserves against the monthly allowance on every request (the terms
 * say requests reserve their maximum usage before settling). A health probe
 * would therefore either prove nothing or burn user quota, so validity is
 * established by the first served request instead (markKeyHealthyFromRequest).
 * A real call with a bad key does answer `401 authentication_error
 * invalid_api_key`, which is what fails it over at request time.
 */
export class IteraComputeProvider extends OpenAICompatProvider {
  constructor() {
    // Free capacity is shared and queues at peak times (429 + Retry-After when
    // full), so the first byte can be slower than the 60s compat default.
    super({ platform: 'iteracompute', name: 'IteraCompute', baseUrl: ITERACOMPUTE_BASE_URL, timeoutMs: 120_000 });
  }

  override get supportsKeyValidation(): boolean {
    return false;
  }

  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // No endpoint distinguishes genuine from bogus keys for free: /models
    // ignores credentials, /chat/completions reserves monthly allowance.
    // Throw so the health pass keeps the key's current state unknown.
    throw new Error('IteraCompute has no free credential-validation endpoint; key validity is unknown (no quota spent)');
  }
}
