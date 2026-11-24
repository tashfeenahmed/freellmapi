import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const LLMKIWI_BASE_URL = 'https://api.llm.kiwi/v1';

// LLM.kiwi (llm.kiwi): OpenAI-compatible. The free plan (no card) serves `auto`
// and `hrllm`; every other model answers 403 pro_model_access_denied. Responses
// carry x-ratelimit-* headers (20 requests a minute per account, 2026-11-23).
//
// GET /v1/models answers 200 with no key and with a bad key, so it proves
// nothing about a key (provider guide rule 1). A chat request with an empty
// body is checked for auth first: a bad key gets 401 invalid_api_key, a good
// key gets 400 missing_messages, and no model runs. It is still a malformed
// request, so the scheduled health pass sends it once per key, not every pass
// (rule 3).
export class LlmKiwiProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'llmkiwi', name: 'LLM.kiwi', baseUrl: LLMKIWI_BASE_URL });
  }

  override get supportsKeyPolling(): boolean {
    return false;
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${LLMKIWI_BASE_URL}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, 10_000, { timeoutBounds: 'request' });
    if (res.status === 401 || res.status === 403) return this.validationResult(res);
    if (res.status === 400) return true;
    throw providerHttpError(res, `LLM.kiwi key validation inconclusive (HTTP ${res.status})`);
  }
}
