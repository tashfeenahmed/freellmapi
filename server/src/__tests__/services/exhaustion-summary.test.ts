import { describe, it, expect } from 'vitest';
import { summarizeExhaustion, formatResetEta } from '../../services/router.js';

// #423: "All models exhausted" gave the caller nothing to act on. The summary
// rolls the per-model routing diagnostics into aggregate, client-safe buckets
// plus a soonest-reset ETA.

describe('formatResetEta', () => {
  const now = 1_000_000_000_000;
  it('formats seconds under 90s', () => {
    expect(formatResetEta(now + 12_000, now)).toBe('~12s');
  });
  it('formats minutes from 90s up', () => {
    expect(formatResetEta(now + 4 * 60_000, now)).toBe('~4m');
  });
  it('formats hours past 90m', () => {
    expect(formatResetEta(now + 3 * 60 * 60_000, now)).toBe('~3h');
  });
  it('returns null for lapsed or missing timestamps', () => {
    expect(formatResetEta(now - 1000, now)).toBeNull();
    expect(formatResetEta(null, now)).toBeNull();
    expect(formatResetEta(undefined, now)).toBeNull();
  });
});

describe('summarizeExhaustion', () => {
  const now = 1_000_000_000_000;

  it('keeps the "All models exhausted" prefix (backwards-compatible)', () => {
    expect(summarizeExhaustion([], null, now)).toMatch(/^All models exhausted/);
    expect(summarizeExhaustion(undefined, null, now)).toMatch(/^All models exhausted/);
  });

  it('buckets rate-limit and cooldown reasons together', () => {
    const diag = [
      'groq/llama-3.3-70b: 2 key(s) — cooldown:1, rpm/rpd-limit:1',
      'google/gemini-1.5-flash: 1 key(s) — tpm/tpd-limit:1',
    ];
    const msg = summarizeExhaustion(diag, null, now);
    expect(msg).toContain('2 routes checked');
    expect(msg).toContain('2 rate-limited or on cooldown');
  });

  it('distinguishes "no usable key" from rate limits', () => {
    const diag = [
      'cohere/command-r: no enabled+healthy key for platform',
      'groq/llama: 1 key(s) — cooldown:1',
    ];
    const msg = summarizeExhaustion(diag, null, now);
    expect(msg).toContain('1 no usable key configured');
    expect(msg).toContain('1 rate-limited or on cooldown');
  });

  it('classifies prompt-too-large lines, not as rate limits', () => {
    const diag = [
      'groq/gpt-oss-120b: tpm_limit 8000 < estimated 33476',
      'google/flash: context 32768 < estimated 40000',
    ];
    const msg = summarizeExhaustion(diag, null, now);
    expect(msg).toContain('2 prompt too large for the model');
    expect(msg).not.toContain('rate-limited');
  });

  it('handles model ids that contain a colon', () => {
    const diag = ['custom/qwen3:4b: no vision support'];
    const msg = summarizeExhaustion(diag, null, now);
    expect(msg).toContain('1 model lacks vision');
  });

  it('appends the soonest-reset ETA when a cooldown is active', () => {
    const diag = ['groq/llama: 1 key(s) — cooldown:1'];
    const msg = summarizeExhaustion(diag, now + 3 * 60_000, now);
    expect(msg).toContain('Soonest reset ~3m.');
  });

  it('omits the ETA when nothing is cooling down', () => {
    const diag = ['cohere/command-r: no enabled+healthy key for platform'];
    expect(summarizeExhaustion(diag, null, now)).not.toContain('Soonest reset');
  });
});
