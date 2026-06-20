import { getDb } from '../db/index.js';

export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: 'success' | 'error',
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null = null,
  ttfbMs: number | null = null,
  requestedModel?: string | null,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (
      platform, model_id, key_id, requested_model, status,
      input_tokens, output_tokens, latency_ms, error, ttfb_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform,
    modelId,
    keyId,
    requestedModel ?? null,
    status,
    inputTokens,
    outputTokens,
    latencyMs,
    error,
    ttfbMs,
  );
}
