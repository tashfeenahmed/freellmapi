import { describe, it, expect } from 'vitest';
import {
  pickSamplingParams,
  extendedBodyParams,
  supportedParametersFor,
  supportedParametersForPlatforms,
  normalizeReasoningEffort,
  EXTENDED_SAMPLING_KEYS,
  REASONING_EFFORTS,
} from '../../lib/sampling-params.js';

describe('pickSamplingParams', () => {
  it('forwards set values and skips undefined/null (#200 explicit-null tolerance)', () => {
    expect(pickSamplingParams({
      seed: 42,
      top_k: 50,
      presence_penalty: 0.5,
      frequency_penalty: null,
      logit_bias: undefined,
      logprobs: true,
      top_logprobs: 5,
    })).toEqual({ seed: 42, top_k: 50, presence_penalty: 0.5, logprobs: true, top_logprobs: 5 });
  });

  it('drops response_format {type:"text"} (the default; some providers 400 on it)', () => {
    expect(pickSamplingParams({ response_format: { type: 'text' } })).toEqual({});
    expect(pickSamplingParams({ response_format: { type: 'json_object' } }))
      .toEqual({ response_format: { type: 'json_object' } });
  });

  it('keeps a full json_schema response_format intact', () => {
    const rf = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object' } } };
    expect(pickSamplingParams({ response_format: rf })).toEqual({ response_format: rf });
  });

  it('returns {} for an empty body', () => {
    expect(pickSamplingParams({})).toEqual({});
  });
});

describe('extendedBodyParams (per-platform policy)', () => {
  const allSet = {
    top_k: 40, min_p: 0.05, seed: 7, presence_penalty: 1, frequency_penalty: -1,
    repetition_penalty: 1.1, logit_bias: { '50256': -100 }, logprobs: true, top_logprobs: 3,
    response_format: { type: 'json_object' as const },
    reasoning_effort: 'medium' as const,
  };

  it('forwards everything for platforms without a policy', () => {
    const body = extendedBodyParams('cerebras', allSet);
    expect(Object.keys(body).sort()).toEqual([...EXTENDED_SAMPLING_KEYS].sort());
  });

  it('mistral: renames seed to random_seed and drops the unsupported set', () => {
    const body = extendedBodyParams('mistral', allSet);
    expect(body.random_seed).toBe(7);
    expect(body).not.toHaveProperty('seed');
    for (const k of ['top_k', 'min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs']) {
      expect(body).not.toHaveProperty(k);
    }
    expect(body.presence_penalty).toBe(1);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('groq: drops the logprobs family, keeps seed and response_format', () => {
    const body = extendedBodyParams('groq', allSet);
    expect(body).not.toHaveProperty('logprobs');
    expect(body).not.toHaveProperty('top_logprobs');
    expect(body).not.toHaveProperty('logit_bias');
    expect(body.seed).toBe(7);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('radeon: keeps only documented knobs and clamps reasoning to the shared roster', () => {
    const body = extendedBodyParams('radeon', { ...allSet, reasoning_effort: 'high' });
    for (const k of ['top_k', 'min_p', 'seed', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs']) {
      expect(body).not.toHaveProperty(k);
    }
    expect(body.presence_penalty).toBe(1);
    expect(body.frequency_penalty).toBe(-1);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('radeon: downgrades unsupported JSON Schema output to JSON-object mode', () => {
    const schema = { type: 'json_schema' as const, json_schema: { name: 'answer', schema: { type: 'object' } } };
    expect(extendedBodyParams('radeon', { response_format: schema }).response_format)
      .toEqual({ type: 'json_object' });
  });

  it('aihorde: drops the entire extended set', () => {
    expect(extendedBodyParams('aihorde', allSet)).toEqual({});
  });

  it('returns {} for undefined options and for options with nothing set', () => {
    expect(extendedBodyParams('groq', undefined)).toEqual({});
    expect(extendedBodyParams('groq', {})).toEqual({});
  });
});

describe('supportedParametersFor / supportedParametersForPlatforms', () => {
  it('advertises the base set minus the platform droplist', () => {
    const groq = supportedParametersFor('groq');
    expect(groq).toContain('seed');
    expect(groq).toContain('response_format');
    expect(groq).not.toContain('logprobs');
    expect(groq).not.toContain('logit_bias');
  });

  it('appends tool params only for tool-capable models', () => {
    expect(supportedParametersFor('groq', { tools: true })).toContain('tools');
    expect(supportedParametersFor('groq', { tools: false })).not.toContain('tools');
  });

  it('intersects across a unify group\'s platforms', () => {
    const both = supportedParametersForPlatforms(['groq', 'mistral']);
    // groq drops logprobs; mistral drops top_k — neither survives the intersection.
    expect(both).not.toContain('logprobs');
    expect(both).not.toContain('top_k');
    // seed survives both (mistral renames it on the wire but honors it).
    expect(both).toContain('seed');
    // single platform = its own list
    expect(supportedParametersForPlatforms(['groq'])).toEqual(supportedParametersFor('groq'));
  });
});

describe('reasoning_effort (request-side reasoning control)', () => {
  it('pickSamplingParams forwards the flat field and drops explicit null', () => {
    expect(pickSamplingParams({ reasoning_effort: 'low' })).toEqual({ reasoning_effort: 'low' });
    expect(pickSamplingParams({ reasoning_effort: null })).toEqual({});
  });

  it('tolerates the object form: reasoning:{effort} resolves to reasoning_effort', () => {
    expect(pickSamplingParams({ reasoning: { effort: 'high' } })).toEqual({ reasoning_effort: 'high' });
  });

  it('flat reasoning_effort wins over the object form on conflict', () => {
    expect(pickSamplingParams({ reasoning_effort: 'low', reasoning: { effort: 'high' } }))
      .toEqual({ reasoning_effort: 'low' });
  });

  it('object form without a usable effort is ignored (never forwarded as-is)', () => {
    expect(pickSamplingParams({ reasoning: null })).toEqual({});
    expect(pickSamplingParams({ reasoning: {} })).toEqual({});
    expect(pickSamplingParams({ reasoning: { effort: null } })).toEqual({});
  });

  it('forwarded verbatim on openai-compat platforms without a droplist entry', () => {
    expect(extendedBodyParams('groq', { reasoning_effort: 'medium' }).reasoning_effort).toBe('medium');
    expect(extendedBodyParams('cerebras', { reasoning_effort: 'none' }).reasoning_effort).toBe('none');
    expect(extendedBodyParams('github', { reasoning_effort: 'high' }).reasoning_effort).toBe('high');
  });

  it('stripped for platforms with no support (never 400s a strict upstream)', () => {
    for (const platform of ['mistral', 'cohere', 'cloudflare', 'aihorde']) {
      expect(extendedBodyParams(platform, { reasoning_effort: 'high' })).not.toHaveProperty('reasoning_effort');
    }
  });

  it('a request without the knob sends nothing new (default behavior unchanged)', () => {
    expect(extendedBodyParams('groq', { seed: 1 })).toEqual({ seed: 1 });
    expect(pickSamplingParams({ seed: 1 })).toEqual({ seed: 1 });
  });

  it('advertised in supported_parameters only where it is forwarded', () => {
    expect(supportedParametersFor('groq')).toContain('reasoning_effort');
    expect(supportedParametersFor('cerebras')).toContain('reasoning_effort');
    expect(supportedParametersFor('mistral')).not.toContain('reasoning_effort');
    expect(supportedParametersFor('cohere')).not.toContain('reasoning_effort');
  });
});

describe('reasoning_effort normalization (#619 — off-scale values must not 400)', () => {
  it('passes supported values through untouched, case/whitespace tolerant', () => {
    for (const effort of REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(effort)).toBe(effort);
    }
    expect(normalizeReasoningEffort('  High ')).toBe('high');
  });

  it("clamps 'max' and its spellings to the top of the scale", () => {
    for (const alias of ['max', 'maximum', 'MAX', 'highest', 'ultra', 'xhigh', 'x-high']) {
      expect(normalizeReasoningEffort(alias)).toBe('high');
    }
  });

  it('clamps the other off-scale spellings to their nearest supported value', () => {
    expect(normalizeReasoningEffort('mid')).toBe('medium');
    expect(normalizeReasoningEffort('balanced')).toBe('medium');
    expect(normalizeReasoningEffort('min')).toBe('minimal');
    expect(normalizeReasoningEffort('lowest')).toBe('minimal');
    expect(normalizeReasoningEffort('off')).toBe('none');
    expect(normalizeReasoningEffort('disabled')).toBe('none');
  });

  it("drops model-managed modes and anything unrecognizable instead of failing", () => {
    for (const value of ['auto', 'adaptive', 'default', 'wat', '', 7, null, undefined, {}]) {
      expect(normalizeReasoningEffort(value)).toBeUndefined();
    }
  });

  it('pickSamplingParams clamps rather than forwarding an off-scale value', () => {
    expect(pickSamplingParams({ reasoning_effort: 'max' })).toEqual({ reasoning_effort: 'high' });
    expect(pickSamplingParams({ reasoning: { effort: 'max' } })).toEqual({ reasoning_effort: 'high' });
    expect(pickSamplingParams({ reasoning_effort: 'adaptive' })).toEqual({});
    expect(pickSamplingParams({ reasoning_effort: 'nonsense', seed: 3 })).toEqual({ seed: 3 });
  });

  it('per-platform clamping: github takes only low/medium/high', () => {
    expect(extendedBodyParams('github', { reasoning_effort: 'none' }).reasoning_effort).toBe('low');
    expect(extendedBodyParams('github', { reasoning_effort: 'minimal' }).reasoning_effort).toBe('low');
    expect(extendedBodyParams('github', { reasoning_effort: 'medium' }).reasoning_effort).toBe('medium');
    // Platforms without a restriction still get the value verbatim.
    expect(extendedBodyParams('groq', { reasoning_effort: 'none' }).reasoning_effort).toBe('none');
  });
});

describe('live-sweep policy findings (2026-07-11 demo-box validation)', () => {
  it('kilo: response_format dropped (gateway 400s on it), seed still forwarded', () => {
    const body = extendedBodyParams('kilo', { seed: 7, response_format: { type: 'json_object' } });
    expect(body.seed).toBe(7);
    expect(body).not.toHaveProperty('response_format');
  });

  it('reka: json_object upgraded to a permissive json_schema on the wire', () => {
    const body = extendedBodyParams('reka', { response_format: { type: 'json_object' } });
    expect((body.response_format as any).type).toBe('json_schema');
    expect((body.response_format as any).json_schema.schema).toEqual({ type: 'object', properties: {}, additionalProperties: true });
  });

  it('reka: an explicit json_schema passes through untouched', () => {
    const rf = { type: 'json_schema' as const, json_schema: { name: 'x', schema: { type: 'object', properties: {} } } };
    const body = extendedBodyParams('reka', { response_format: rf });
    expect(body.response_format).toBe(rf);
  });

  it('kilo is skipped by structured-output routing; reka is not', async () => {
    const { platformDropsResponseFormat } = await import('../../lib/sampling-params.js');
    expect(platformDropsResponseFormat('kilo')).toBe(true);
    expect(platformDropsResponseFormat('reka')).toBe(false);
  });
});
