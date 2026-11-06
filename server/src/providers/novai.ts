import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions, KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const NOVAI_BASE_URL = 'https://aiapi-pro.com/v1';

const CHAT_MODELS = new Set(['glm-4.6v-flash', 'glm-4.1v-thinking-flash']);
const THINKING_MODEL = 'glm-4.1v-thinking-flash';
const WRAPPERS = [['<answer>', '</answer>'], ['<|begin_of_box|>', '<|end_of_box|>']] as const;

/** Strip only an opening answer envelope and its final closing delimiter.
 * Interior literals stay intact. Holds at most 512 leading whitespace bytes
 * and a possible closing delimiter, never the complete streamed answer. */
class AnswerEnvelope {
  private state: 'leading' | 'wrapped' | 'passthrough' = 'leading';
  private held = '';
  private close = '';

  push(text: string): string {
    let input = this.held + text;
    this.held = '';
    if (this.state === 'leading') {
      const trimmed = input.trimStart();
      const wrapper = WRAPPERS.find(([open]) => trimmed.startsWith(open));
      if (wrapper) {
        this.state = 'wrapped';
        this.close = wrapper[1];
        input = trimmed.slice(wrapper[0].length);
      } else if (input.length <= 512 && WRAPPERS.some(([open]) => open.startsWith(trimmed))) {
        this.held = input;
        return '';
      } else {
        this.state = 'passthrough';
      }
    }
    if (this.state === 'passthrough') return input;
    const trimmed = input.trimEnd();
    let hold = 0;
    if (trimmed.endsWith(this.close) && input.length - trimmed.length <= 512) {
      hold = this.close.length + input.length - trimmed.length;
    } else {
      for (let n = Math.min(input.length, this.close.length - 1); n > 0; n--) {
        if (this.close.startsWith(input.slice(-n))) { hold = n; break; }
      }
    }
    this.held = hold ? input.slice(-hold) : '';
    return input.slice(0, input.length - hold);
  }

  flush(): string {
    const tail = this.state === 'wrapped' && this.held.trimEnd() === this.close ? '' : this.held;
    this.held = '';
    this.state = 'passthrough';
    return tail;
  }
}

/** Some responses nest the native box inside an XML answer envelope. Keep
 * both layers incremental and bounded instead of buffering the whole reply. */
class AnswerFilter {
  private outer = new AnswerEnvelope();
  private inner = new AnswerEnvelope();
  push(text: string): string { return this.inner.push(this.outer.push(text)); }
  flush(): string { return this.inner.push(this.outer.flush()) + this.inner.flush(); }
}

function checkModel(model: string): void {
  if (!CHAT_MODELS.has(model)) {
    throw Object.assign(new Error('NovAI chat supports only the tested daily-free GLM routes'), { status: 400 });
  }
}

function checkIdentity(requested: string, returned: unknown): void {
  if (returned !== requested) {
    throw Object.assign(new Error('NovAI returned a different or missing model identity'), { status: 502 });
  }
}

/** Chat and video share NovAI's daily free allowance. Rows are delivered only
 * by the signed catalog; registering a key never bypasses the 30-day gate. */
export class NovaiProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'novai', name: 'NovAI', baseUrl: NOVAI_BASE_URL });
  }
  override get supportsKeyValidation(): boolean { return false; }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim()) return { valid: false, error: 'NovAI API key is required' };
    // /models is public and cannot authenticate a credential. Do not spend a
    // video generation (or pretend that a public roster validates the key).
    throw new Error('NovAI has no verified credential-validation endpoint; key validity is unknown');
  }

  override async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    checkModel(modelId);
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkIdentity(modelId, response.model);
    if (modelId === THINKING_MODEL) {
      for (const choice of response.choices ?? []) {
        if (typeof choice.message.content !== 'string') continue;
        const filter = new AnswerFilter();
        choice.message.content = filter.push(choice.message.content) + filter.flush();
      }
    }
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    checkModel(modelId);
    const filters = new Map<number, AnswerFilter>();
    let last: ChatCompletionChunk | undefined;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkIdentity(modelId, chunk.model);
      last = chunk;
      if (modelId === THINKING_MODEL) for (const choice of chunk.choices ?? []) {
        let filter = filters.get(choice.index);
        if (!filter) { filter = new AnswerFilter(); filters.set(choice.index, filter); }
        if (typeof choice.delta.content === 'string') choice.delta.content = filter.push(choice.delta.content);
        if (choice.finish_reason) {
          const tail = filter.flush();
          if (tail) choice.delta.content = (choice.delta.content ?? '') + tail;
        }
      }
      yield chunk;
    }
    // Preserve partial delimiters if the upstream ends without a finish frame.
    if (last) for (const [index, filter] of filters) {
      const tail = filter.flush();
      if (tail) yield { ...last, choices: [{ index, delta: { content: tail }, finish_reason: null }] };
    }
  }
}
