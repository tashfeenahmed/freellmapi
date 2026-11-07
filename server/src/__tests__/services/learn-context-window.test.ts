import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { parseProviderContextWindow, learnContextWindowFromError } from '../../services/ratelimit.js';

describe('parseProviderContextWindow', () => {
  it('parses the OpenRouter endpoint body from #1479', () => {
    const msg = "OpenRouter API error 400: This endpoint's maximum context length is 262144 tokens. However, you requested about 404225 tokens (396033 of text input, 8192 in the output). Please reduce the length of either one, or use the \"middle-out\" transform to compress your prompt automatically.";
    expect(parseProviderContextWindow(msg)).toBe(262144);
  });

  it('parses the OpenAI-compatible wording', () => {
    expect(parseProviderContextWindow("Groq API error 400: This model's maximum context length is 131072 tokens. However, your messages resulted in 140000 tokens.")).toBe(131072);
  });

  it('parses the Mistral wording', () => {
    expect(parseProviderContextWindow('Prompt contains 140000 tokens and 0 draft tokens, too large for model with 131072 maximum context length')).toBe(131072);
  });

  it('parses the Anthropic wording', () => {
    expect(parseProviderContextWindow('prompt is too long: 210000 tokens > 200000 maximum')).toBe(200000);
  });

  it('parses the Google wording', () => {
    expect(parseProviderContextWindow('The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).')).toBe(1048576);
  });

  it('strips thousands separators', () => {
    expect(parseProviderContextWindow('maximum context length is 262,144 tokens')).toBe(262144);
  });

  it('never reads the requested size or a TPM limit as the window', () => {
    expect(parseProviderContextWindow('you requested about 404225 tokens (396033 of text input, 8192 in the output)')).toBeNull();
    expect(parseProviderContextWindow('Request too large for model on tokens per minute (TPM): Limit 30000, Requested 33476')).toBeNull();
    expect(parseProviderContextWindow('Request body too large for gpt-4.1 model. Max size: 8000 tokens.')).toBeNull();
  });

  it('rejects an implausibly small window as a misread', () => {
    expect(parseProviderContextWindow('maximum context length is 512 tokens')).toBeNull();
  });

  it('returns null for empty and unrelated errors', () => {
    expect(parseProviderContextWindow('')).toBeNull();
    expect(parseProviderContextWindow(undefined)).toBeNull();
    expect(parseProviderContextWindow('API error 500: internal server error')).toBeNull();
  });
});

describe('learnContextWindowFromError (persistence)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function insertModel(contextWindow: number | null): number {
    const info = getDb().prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window)
       VALUES ('openrouter', ?, 'M', 50, 50, ?)`,
    ).run(`m-${Math.random().toString(36).slice(2)}`, contextWindow);
    return info.lastInsertRowid as number;
  }
  const windowOf = (id: number) =>
    (getDb().prepare('SELECT context_window FROM models WHERE id = ?').get(id) as { context_window: number | null }).context_window;
  const tooLong = { message: "This endpoint's maximum context length is 262144 tokens. However, you requested about 404225 tokens." };

  it('lowers a catalog window the endpoint does not honor', () => {
    const id = insertModel(1_000_000);
    expect(learnContextWindowFromError(id, tooLong)).toBe(262144);
    expect(windowOf(id)).toBe(262144);
  });

  it('fills an unknown window', () => {
    const id = insertModel(null);
    expect(learnContextWindowFromError(id, tooLong)).toBe(262144);
    expect(windowOf(id)).toBe(262144);
  });

  it('never raises a window that is already lower', () => {
    const id = insertModel(131072);
    expect(learnContextWindowFromError(id, tooLong)).toBeNull();
    expect(windowOf(id)).toBe(131072);
  });

  it('is a no-op for an error that names no window', () => {
    const id = insertModel(200000);
    expect(learnContextWindowFromError(id, { message: 'Request Entity Too Large' })).toBeNull();
    expect(windowOf(id)).toBe(200000);
  });
});

describe('learnContextWindowFromError with the refused request size (#1717)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function insertModel(contextWindow: number | null): number {
    const info = getDb().prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, context_window)
       VALUES ('bazaarlink', ?, 'M', 50, 50, ?)`,
    ).run(`m-${Math.random().toString(36).slice(2)}`, contextWindow);
    return info.lastInsertRowid as number;
  }
  const windowOf = (id: number) =>
    (getDb().prepare('SELECT context_window FROM models WHERE id = ?').get(id) as { context_window: number | null }).context_window;
  const freeTier = { message: 'BazaarLink API error 400: This request is too large for a free tier' };

  it('learns a ceiling below the refused size when the provider names no window', () => {
    const id = insertModel(1_048_576);
    expect(learnContextWindowFromError(id, freeTier, 500_000)).toBe(450_000);
    expect(windowOf(id)).toBe(450_000);
  });

  it('only ever lowers the window', () => {
    const id = insertModel(131_072);
    expect(learnContextWindowFromError(id, freeTier, 500_000)).toBeNull();
    expect(windowOf(id)).toBe(131_072);
  });

  it('prefers a window the provider names over the refused size', () => {
    const id = insertModel(1_048_576);
    const named = { message: "This endpoint's maximum context length is 262144 tokens." };
    expect(learnContextWindowFromError(id, named, 500_000)).toBe(262144);
  });

  it('leaves per-minute throughput rejections to the tpm learner', () => {
    const id = insertModel(131_072);
    const groq = { message: 'Request too large for model `x` on tokens per minute (TPM): Limit 30000, Requested 33476' };
    expect(learnContextWindowFromError(id, groq, 33_476)).toBeNull();
    expect(windowOf(id)).toBe(131_072);
  });
});
