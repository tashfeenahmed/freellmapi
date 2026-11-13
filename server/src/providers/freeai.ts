import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, type KeyValidationResult } from './base.js';

export const FREEAI_BASE_URL = 'https://api.free.ai';

/** Only download the output shape exercised live, not arbitrary upstream URLs. */
export function freeAiAudioUrl(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('audio_url' in body) || typeof body.audio_url !== 'string') return null;
  try {
    const url = new URL(body.audio_url);
    if (url.origin !== FREEAI_BASE_URL || url.username || url.password || url.search || url.hash
      || !/^\/static\/outputs\/[0-9a-f-]{36}\.wav$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

/** TTS-only until the mismatched chat aliases are resolved. Free accounts share
 * 30K tokens/day and 1K API requests/month (no card; verified 2026-10-11).
 * https://free.ai/api/ — model rows belong only in the signed catalog. */
export class FreeAiProvider extends BaseProvider {
  readonly platform = 'freeai' as const;
  readonly name = 'Free.ai';

  // No published endpoint distinguishes genuine from bogus keys. Skip
  // scheduled health probes instead of persisting an inconclusive error.
  override get supportsKeyValidation(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (!apiKey.trim()) return { valid: false, error: 'Free.ai API key is required' };
    // Live controls (2026-10-11): /models, invalid-model errors and even Kokoro
    // synthesis returned the same status with valid and bogus credentials.
    // None proves authentication. Do not burn quota or mark a bogus key valid.
    // The existing health service preserves unknown/healthy state on an
    // inconclusive probe, so a configured key can still serve normal requests.
    throw new Error('Free.ai has no verified credential-validation endpoint; key validity is unknown (no quota spent)');
  }

  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw Object.assign(new Error('Free.ai currently supports /v1/audio/speech, not chat completions'), { status: 400 });
  }

  // eslint-disable-next-line require-yield
  async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
    throw Object.assign(new Error('Free.ai currently supports /v1/audio/speech, not chat completions'), { status: 400 });
  }
}
