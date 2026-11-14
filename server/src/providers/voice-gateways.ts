import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** Native speech APIs, not OpenAI chat endpoints. Their model/voice lists are
 * not credential probes. Never spend the monthly grant while adding a key or
 * seed model rows ahead of the signed catalog's existing 30-day release gate. */
class NativeSpeechProvider extends BaseProvider {
  readonly supportsChat = false;
  constructor(readonly platform: 'typecast' | 'cartesia', readonly name: string) { super(); }
  override get supportsKeyValidation(): boolean { return false; }
  async validateKey(): Promise<KeyValidationResult> {
    throw new Error(`${this.name} key validity is established by the first speech request`);
  }
  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error(`${this.name} supports native speech, not chat completions`), { status: 400 });
  }
  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error(`${this.name} supports native speech, not chat completions`), { status: 400 });
  }
}
export class TypecastProvider extends NativeSpeechProvider {
  constructor() { super('typecast', 'Typecast'); }
}
export class CartesiaProvider extends NativeSpeechProvider {
  constructor() { super('cartesia', 'Cartesia'); }
}
