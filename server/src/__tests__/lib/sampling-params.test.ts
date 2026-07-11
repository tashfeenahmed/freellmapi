import { describe, it, expect } from 'vitest';
import {
  pickSamplingParams,
  extendedBodyParams,
  supportedParametersFor,
  supportedParametersForPlatforms,
  EXTENDED_SAMPLING_KEYS,
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

describe('live-sweep policy findings (2026-07-11 demo-box validation)', () => {
  it('kilo: response_format dropped (gateway 400s on it), seed still forwarded', () => {
    const body = extendedBodyParams('kilo', { seed: 7, response_format: { type: 'json_object' } });
    expect(body.seed).toBe(7);
    expect(body).not.toHaveProperty('response_format');
  });

  it('reka: json_object upgraded to a permissive json_schema on the wire', () => {
    const body = extendedBodyParams('reka', { response_format: { type: 'json_object' } });
    expect((body.response_format as any).type).toBe('json_schema');
    expect((body.response_format as any).json_schema.schema).toEqual({ type: 'object' });
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
