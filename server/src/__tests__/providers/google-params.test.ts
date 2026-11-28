import { describe, it, expect } from 'vitest';
import { toGeminiExtendedConfig } from '../../providers/google.js';

describe('toGeminiExtendedConfig', () => {
  it('maps top_k/seed/penalties to generationConfig names', () => {
    const cfg = toGeminiExtendedConfig({
      top_k: 40, seed: 7, presence_penalty: 0.5, frequency_penalty: -0.5,
    });
    expect(cfg).toEqual({ topK: 40, seed: 7, presencePenalty: 0.5, frequencyPenalty: -0.5 });
  });

  it('json_object → responseMimeType only', () => {
    const cfg = toGeminiExtendedConfig({ response_format: { type: 'json_object' } });
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg).not.toHaveProperty('responseSchema');
  });

  it('json_schema → responseMimeType + sanitized responseSchema', () => {
    const cfg = toGeminiExtendedConfig({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: {
            type: 'object',
            additionalProperties: false, // Gemini rejects this key — must be stripped
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    });
    expect(cfg.responseMimeType).toBe('application/json');
    const schema = cfg.responseSchema as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).not.toContain('additionalProperties');
    expect((schema.properties as Record<string, unknown>).city).toBeDefined();
  });

  it('skips JSON output entirely when tools are present (Gemini rejects the combination)', () => {
    const cfg = toGeminiExtendedConfig({
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    });
    expect(cfg).not.toHaveProperty('responseMimeType');
    expect(cfg).not.toHaveProperty('responseSchema');
  });

  it('grounding-only pseudo-tools do NOT suppress structured output', () => {
    // google_search converts to a grounding block, not functionDeclarations —
    // raw tools.length was silently dropping responseMimeType for it.
    const cfg = toGeminiExtendedConfig({
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'google_search', parameters: {} } }],
    });
    expect(cfg.responseMimeType).toBe('application/json');
  });

  it('a grounding tool alongside a real function still suppresses structured output', () => {
    const cfg = toGeminiExtendedConfig({
      response_format: { type: 'json_object' },
      tools: [
        { type: 'function', function: { name: 'google_search', parameters: {} } },
        { type: 'function', function: { name: 'f', parameters: {} } },
      ],
    });
    expect(cfg).not.toHaveProperty('responseMimeType');
  });

  it('returns all-undefined fields for empty options (JSON.stringify drops them)', () => {
    const cfg = toGeminiExtendedConfig(undefined);
    expect(cfg.topK).toBeUndefined();
    expect(cfg.responseMimeType).toBeUndefined();
  });

  it('reasoning_effort maps to thinkingConfig with the effort-tier budget', () => {
    expect(toGeminiExtendedConfig({ reasoning_effort: 'low' }).thinkingConfig)
      .toEqual({ thinkingBudget: 1024, includeThoughts: true });
    expect(toGeminiExtendedConfig({ reasoning_effort: 'medium' }).thinkingConfig)
      .toEqual({ thinkingBudget: 8192, includeThoughts: true });
    expect(toGeminiExtendedConfig({ reasoning_effort: 'high' }).thinkingConfig)
      .toEqual({ thinkingBudget: 24576, includeThoughts: true });
  });

  it("reasoning_effort 'none'/'minimal' disables thinking (budget 0)", () => {
    expect(toGeminiExtendedConfig({ reasoning_effort: 'none' }).thinkingConfig)
      .toEqual({ thinkingBudget: 0 });
    expect(toGeminiExtendedConfig({ reasoning_effort: 'minimal' }).thinkingConfig)
      .toEqual({ thinkingBudget: 0 });
  });

  it('no reasoning_effort → no thinkingConfig (model default preserved)', () => {
    expect(toGeminiExtendedConfig({ seed: 1 })).not.toHaveProperty('thinkingConfig');
    expect(toGeminiExtendedConfig(undefined)).not.toHaveProperty('thinkingConfig');
  });

  it('thinking_budget overrides the effort-tier default while none still disables thinking', () => {
    expect(toGeminiExtendedConfig({ thinking_budget: 4096 }).thinkingConfig)
      .toEqual({ thinkingBudget: 4096, includeThoughts: true });
    expect(toGeminiExtendedConfig({ reasoning_effort: 'low', thinking_budget: 16384 }).thinkingConfig)
      .toEqual({ thinkingBudget: 16384, includeThoughts: true });
    expect(toGeminiExtendedConfig({ reasoning_effort: 'none', thinking_budget: 16384 }).thinkingConfig)
      .toEqual({ thinkingBudget: 0 });
    expect(toGeminiExtendedConfig({ thinking_budget: 0 }).thinkingConfig)
      .toEqual({ thinkingBudget: 0 });
  });
});
