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
