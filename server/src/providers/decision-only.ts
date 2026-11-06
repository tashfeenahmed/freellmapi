import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

/** Explicitly activated with the normal no-key credential. Decision-only
 * providers must never silently accept a chat completion or send a secret. */
export class KeylessDecisionProvider extends BaseProvider {
  keyless = true;

  constructor(readonly platform: 'halx' | 'aisense', readonly name: string) { super(); }

  async validateKey(): Promise<KeyValidationResult> { return true; }

  async chatCompletion(_key: string, _messages: ChatMessage[], _model: string): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error(`${this.name} supports /v1/decisions, not chat completions`), { status: 422 });
  }

  // eslint-disable-next-line require-yield -- refusal must reject on iterator.next()
  async *streamChatCompletion(_key: string, _messages: ChatMessage[], _model: string): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error(`${this.name} supports /v1/decisions, not chat completions`), { status: 422 });
  }
}
