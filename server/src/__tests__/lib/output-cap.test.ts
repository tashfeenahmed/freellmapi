import { describe, it, expect, beforeEach } from 'vitest';
import {
  learnOutputCapFromError,
  learnedOutputCap,
  parseMaxTokensCeiling,
  resetLearnedOutputCaps,
  routeOutputBudget,
} from '../../lib/output-cap.js';

// Live bodies, 2026-09-29, for Claude Code's max_tokens of 128000.
const OLLAMA = "Ollama Cloud API error 400: max_tokens (128000) exceeds model's maximum output tokens (65536) for model nemotron-3-ultra (ref: 3761884e-8e9b-4c46-8526-5de77ebe3c25)";
const GROQ = 'Groq API error 400: `max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model';

beforeEach(() => resetLearnedOutputCaps());

describe('parseMaxTokensCeiling', () => {
  it('reads the ceiling from Ollama Cloud and Groq rejections', () => {
    expect(parseMaxTokensCeiling(OLLAMA)).toBe(65536);
    expect(parseMaxTokensCeiling(GROQ)).toBe(65536);
    expect(parseMaxTokensCeiling('max_completion_tokens must be at most 32768')).toBe(32768);
  });

  it('reads the ceiling from the phrasings the first cut missed', () => {
    // Providers whose wording the original CEILING alternation did not carry:
    // each one still benched the model instead of clamping and retrying.
    expect(parseMaxTokensCeiling('OpenRouter error 400: max_tokens exceeds the maximum allowed value of 4096')).toBe(4096);
    expect(parseMaxTokensCeiling('Together API error 400: max_tokens (128000) exceeds the model maximum output tokens of 65536')).toBe(65536);
    expect(parseMaxTokensCeiling('Fireworks 400: max_tokens: 128000 is greater than the maximum 16384')).toBe(16384);
    expect(parseMaxTokensCeiling('DeepInfra 400: max_tokens must be less than 8192')).toBe(8192);
    expect(parseMaxTokensCeiling('custom endpoint 422: max_output_tokens: 100000 is at most 16384')).toBe(16384);
  });

  it('reads the space-spelled "max tokens" and "max_output" wordings (Septor, Cohere)', () => {
    // Live rejections the gateway failed to learn from (2026-11-14).
    expect(parseMaxTokensCeiling('custom API error 400: Requested max tokens (104394) exceeds model max_output (8192)')).toBe(8192);
    expect(parseMaxTokensCeiling('Requested max tokens (32000) exceeds model max_output (16384)')).toBe(16384);
    expect(parseMaxTokensCeiling('Cohere API error 400: max tokens must be less than or equal to 4096')).toBe(4096);
    expect(parseMaxTokensCeiling('Cohere API error 400: invalid request: max tokens must be less than or equal to 4096, received 103643')).toBe(4096);
    // The 65536 readings (Groq / Ollama) are unchanged by the wider pattern.
    expect(parseMaxTokensCeiling(GROQ)).toBe(65536);
    expect(parseMaxTokensCeiling(OLLAMA)).toBe(65536);
    expect(parseMaxTokensCeiling('max tokens (128000) exceeds model\'s maximum output tokens (65536)')).toBe(65536);
  });

  it('keeps the wider spellings from reading unrelated numbers', () => {
    expect(parseMaxTokensCeiling('max tokens: requested 16000, the number of input tokens exceeds 200 tokens')).toBeNull();
    expect(parseMaxTokensCeiling('Request exceeds 30000 TPM limit; max tokens=4096')).toBeNull();
    expect(parseMaxTokensCeiling('max tokens must be a positive integer')).toBeNull();
    expect(parseMaxTokensCeiling('model max_output is not configured; input tokens exceeds 200000')).toBeNull();
  });

  it('ignores context-window and unrelated errors', () => {
    expect(parseMaxTokensCeiling('Cloudflare API error 413: AiError: Ai: The estimated number of input and maximum output tokens (24092) exceeded this model context window limit (24000).')).toBeNull();
    expect(parseMaxTokensCeiling('Groq API error 413: Request too large for model `x` on tokens per minute (TPM): Limit 8000, Requested 17679')).toBeNull();
    expect(parseMaxTokensCeiling('max_tokens must be a positive integer')).toBeNull();
  });

  it('never reads a number that belongs to some other limit', () => {
    expect(parseMaxTokensCeiling('max_tokens: requested 16000, the number of input tokens exceeds 200 tokens')).toBeNull();
    expect(parseMaxTokensCeiling('Request exceeds 30000 TPM limit; max_tokens=4096')).toBeNull();
    expect(parseMaxTokensCeiling('quota exceeds 500 credits; set max_tokens lower')).toBeNull();
    expect(parseMaxTokensCeiling('max_completion_tokens: messages must have less than 1000 items')).toBeNull();
  });
});

describe('learned output caps', () => {
  const route = { platform: 'ollama', modelId: 'nemotron-3-ultra', contextWindow: 262144 };

  it('learns from a 400 and keeps the lowest reading', () => {
    expect(learnOutputCapFromError(route, Object.assign(new Error(OLLAMA), { status: 400 }))).toBe(65536);
    learnOutputCapFromError(route, Object.assign(new Error('max_tokens must be at most 32768'), { status: 400 }));
    expect(learnedOutputCap('ollama', 'nemotron-3-ultra')).toBe(32768);
  });

  it('does not learn from a non-400 status', () => {
    expect(learnOutputCapFromError(route, Object.assign(new Error(OLLAMA), { status: 503 }))).toBeNull();
    expect(learnedOutputCap('ollama', 'nemotron-3-ultra')).toBeUndefined();
  });

  it('ignores a reading below the floor', () => {
    expect(learnOutputCapFromError(route, Object.assign(new Error('max_tokens must be at most 512'), { status: 400 }))).toBeNull();
    expect(learnedOutputCap('ollama', 'nemotron-3-ultra')).toBeUndefined();
    expect(learnOutputCapFromError(route, Object.assign(new Error('max_tokens must be at most 1024'), { status: 400 }))).toBe(1024);
  });

  it('lowers the route output budget to the learned cap', () => {
    expect(routeOutputBudget(route, 20000)).toBe(242144);
    learnOutputCapFromError(route, Object.assign(new Error(OLLAMA), { status: 400 }));
    expect(routeOutputBudget(route, 20000)).toBe(65536);
    expect(routeOutputBudget({ ...route, contextWindow: 50000 }, 20000)).toBe(30000);
    expect(routeOutputBudget({ ...route, contextWindow: null }, 20000)).toBe(65536);
  });
});

describe('learned caps are per endpoint (#651 identity, #1230 precedent)', () => {
  // Two custom relays serving the same model id share platform 'custom'; only
  // endpoint_scope tells them apart. A ceiling learned from relay A must not
  // clamp relay B's replies (and a catalog platform must never be clamped by
  // anything a relay learned).
  const relayA = { platform: 'custom', modelId: 'deepseek-v3.1', contextWindow: 131072, endpointScope: 'https://relay-a.example.com/v1' };
  const relayB = { platform: 'custom', modelId: 'deepseek-v3.1', contextWindow: 131072, endpointScope: 'https://relay-b.example.com/v1' };
  const rejection = (ceiling: number) => Object.assign(
    new Error(`max_tokens (128000) exceeds model's maximum output tokens (${ceiling})`),
    { status: 400 },
  );

  it('keeps one relay ceiling out of a sibling relay on the same model id', () => {
    expect(learnOutputCapFromError(relayA, rejection(32768))).toBe(32768);
    expect(routeOutputBudget(relayA, 1000)).toBe(32768);
    // Relay B serves the same model id but never rejected anything.
    expect(learnedOutputCap(relayB.platform, relayB.modelId, relayB.endpointScope)).toBeUndefined();
    expect(routeOutputBudget(relayB, 1000)).toBe(130072);
  });

  it('keeps a relay ceiling out of the catalog row for the same model id', () => {
    learnOutputCapFromError(relayA, rejection(32768));
    expect(learnedOutputCap('custom', 'deepseek-v3.1')).toBeUndefined();
    expect(routeOutputBudget({ platform: 'custom', modelId: 'deepseek-v3.1', contextWindow: 131072 }, 1000)).toBe(130072);
  });

  it('treats a missing scope and an empty scope as the same identity', () => {
    learnOutputCapFromError({ platform: 'custom', modelId: 'm', endpointScope: '' }, rejection(8192));
    expect(learnedOutputCap('custom', 'm', undefined)).toBe(8192);
    expect(learnedOutputCap('custom', 'm', null)).toBe(8192);
    // And a scoped reading never leaks into the un-scoped identity either.
    expect(learnedOutputCap('custom', 'm', 'https://relay-x.example.com')).toBeUndefined();
  });
});
