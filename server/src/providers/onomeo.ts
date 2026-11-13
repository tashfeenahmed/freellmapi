import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const ONOMEO_BASE_URL = 'https://onomeo.com/v1';

// Retired IDs can return HTTP 200 with a different model (observed 2026-10-24).
// Fail over instead of attributing that answer to the requested catalog route.
function checkModelIdentity(requested: string, returned: unknown): void {
  if (typeof returned !== 'string' || !returned || returned !== requested) {
    throw Object.assign(new Error('onomeo returned a different or missing model identity'), { status: 502 });
  }
}

// Free-tier answers end with this line (verified live 2026-10-21: every text
// reply, streamed as its own final delta "\n\n— via onomeo.com"; tool-call
// turns carry none). It is provider branding, not model output, so it must not
// reach clients or agents that parse the text.
const SIGNATURE = '— via onomeo.com';
const SIGNATURE_TAIL = /\s*— via onomeo\.com\s*$/;
const SIGNATURE_FORMS = [`\n\n${SIGNATURE}`, `\n${SIGNATURE}`, SIGNATURE];

export function stripOnomeoSignature(text: string): string {
  return text.replace(SIGNATURE_TAIL, '');
}

/** Length of the longest suffix of `text` that could still grow into the
 *  signature, so a stream holds back only what might be branding. */
function heldSuffixLength(text: string): number {
  let held = 0;
  for (const form of SIGNATURE_FORMS) {
    for (let n = Math.min(form.length, text.length); n > held; n--) {
      if (form.startsWith(text.slice(text.length - n))) { held = n; break; }
    }
  }
  return held;
}

/**
 * onomeo (#1460): an OpenAI-compatible gateway whose free models share one
 * call-counted allowance — 30 calls per 5-hour window per account, with a
 * site-wide pool and a `too_fast` per-minute guard on top. Model rows are
 * published only through the signed catalog; nothing here enrolls models.
 *
 * Error vocabulary (from https://onomeo.com/integrations):
 * - 401 `bad_key` — the only authentication verdict; invalid.
 * - 403 `account_quota` / `network_quota` and 429 `site_busy` / `too_fast` —
 *   quota and throttle answers on a VALID key. Treating 403 as an invalid key
 *   (the base `validationResult` rule) would auto-disable a good key the first
 *   time its 5-hour calls run out, so those statuses stay inconclusive here.
 */
export class OnomeoProvider extends OpenAICompatProvider {
  constructor() {
    // GET /v1/models is the keyed endpoint: anonymous and bad-key callers both
    // get 401 (verified live), so it is a real credential probe.
    super({ platform: 'onomeo', name: 'onomeo', baseUrl: ONOMEO_BASE_URL, validateUrl: `${ONOMEO_BASE_URL}/models` });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (response.status === 401) return super.validationResult(response);
    // 403/429 are quota/throttle verdicts on a valid key (see class docs), and
    // every other failure is an outage — all inconclusive, none key-fatal.
    if (!response.ok) throw providerHttpError(response, 'onomeo key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
    if (!Array.isArray(body?.data) || body?.error) {
      throw Object.assign(new Error('onomeo returned an invalid model list'), { status: 502 });
    }
    return true;
  }

  override async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModelIdentity(modelId, response.model);
    for (const choice of response.choices ?? []) {
      if (typeof choice.message?.content === 'string') {
        choice.message.content = stripOnomeoSignature(choice.message.content);
      }
    }
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    // Text that might be the start of the signature is held back until the
    // next delta settles it; a signature at the end of the stream is dropped.
    let held = '';
    let lastChunk: ChatCompletionChunk | null = null;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      // Check every frame, including role/tool/finish frames, before yielding
      // or retaining any of its content. Never rewrite the upstream identity.
      checkModelIdentity(modelId, chunk.model);
      lastChunk = chunk;
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content !== 'string') {
        if (held && chunk.choices?.[0]?.finish_reason) {
          const tail = stripOnomeoSignature(held);
          held = '';
          if (tail && delta) delta.content = tail;
        }
        yield chunk;
        continue;
      }
      const hadText = delta.content.length > 0;
      let text = held + delta.content;
      if (text.trimEnd().endsWith(SIGNATURE)) text = stripOnomeoSignature(text);
      const keep = heldSuffixLength(text);
      held = text.slice(text.length - keep);
      delta.content = text.slice(0, text.length - keep);
      // Skip only a delta whose text was entirely held back or stripped; role
      // and finish chunks with empty content still pass through.
      if (delta.content || !hadText || chunk.choices[0].finish_reason) yield chunk;
    }
    const tail = stripOnomeoSignature(held);
    if (tail && lastChunk) {
      yield {
        ...lastChunk,
        choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
      } as ChatCompletionChunk;
    }
  }
}
