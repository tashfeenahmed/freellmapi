import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const LLMTR_BASE_URL = 'https://llmtr.com/v1';
const VALIDATION_MODEL = '__freellmapi_key_validation__';

function checkModel(requested: string, returned: string): void {
  if (returned !== requested) {
    throw Object.assign(new Error('LLMTR returned a different or missing model identity'), { status: 502 });
  }
}

// LLMTR's anti-abuse system flags bursts of __freellmapi_key_validation__
// requests as bot traffic and suspends accounts (#1369). Every validation
// source (health pass, cooldown probe, manual save) routes through
// validateKey, so serializing them with a global min-gap here caps probe
// rate no matter how many keys or workers the health pass uses.
// 5s = at most 12 probes/min. Env-overridable so tests can collapse the gap.
const VALIDATION_MIN_GAP_MS = (() => {
  const n = Number(process.env.LLMTR_VALIDATION_MIN_GAP_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
})();
let validationChain: Promise<void> = Promise.resolve();

/** Serialize validation calls behind a process-wide min-gap. */
function gateValidation<T>(fn: () => Promise<T>): Promise<T> {
  const run = validationChain.then(async () => {
    await new Promise(resolve => setTimeout(resolve, VALIDATION_MIN_GAP_MS));
  }).then(fn);
  validationChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Selected zero-priced routes have renewable daily/rolling quotas, not a
 * monthly cash grant. Only the signed catalog supplies model rows: the public
 * roster also contains paid models, expiring promotions and BYOK-only rows. */
export class LlmtrProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'llmtr', name: 'LLMTR', baseUrl: LLMTR_BASE_URL });
  }

  override validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    return gateValidation(() => this.validateKeyGated(apiKey, quotaContext));
  }

  private async validateKeyGated(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // /models is public; /api/usage expects a dashboard token. This nonexistent
    // model checks authentication without generating tokens: live controls on
    // 2026-09-29 returned 401/auth_error for an invalid key and
    // 404/model_not_found for the valid key. Do not accept generic 404s.
    const res = await this.fetchWithTimeout(`${LLMTR_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: VALIDATION_MODEL, messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
    }, providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform, endpoint: 'key-validation' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (res.status === 404) {
      const body = await res.clone().json().catch(() => null) as { error?: { type?: string } } | null;
      if (body?.error?.type === 'model_not_found') return true;
    }
    throw providerHttpError(res, 'LLMTR key validation is temporarily inconclusive');
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
