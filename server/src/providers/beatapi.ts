import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const BEATAPI_BASE_URL = 'https://api.beatapi.io/v1';

export class BeatApiProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'beatapi', name: 'BeatAPI', baseUrl: BEATAPI_BASE_URL });
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BEATAPI_BASE_URL}/models`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'BeatAPI key validation is inconclusive');
    const body = await res.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
    if (!Array.isArray(body?.data) || body?.error) {
      throw Object.assign(new Error('BeatAPI returned an invalid model list'), { status: 502 });
    }
    return true;
  }
}
