import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseModelWeightOverrides,
  applyModelWeightOverride,
  getModelWeightOverrides,
  resetModelWeightOverrides,
} from '../../services/model-weight-overrides.js';

const ORIGINAL_ENV = process.env.MODEL_ROUTING_OVERRIDES;

describe('model weight overrides', () => {
  beforeEach(() => {
    resetModelWeightOverrides();
  });

  afterEach(() => {
    resetModelWeightOverrides();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MODEL_ROUTING_OVERRIDES;
    } else {
      process.env.MODEL_ROUTING_OVERRIDES = ORIGINAL_ENV;
    }
  });

  it('parses a valid JSON object of model multipliers', () => {
    const map = parseModelWeightOverrides('{"gpt-4o": 0.2, "deepseek-v3": 0.8, "claude-3.5": 1}');
    expect([...map.entries()]).toEqual([
      ['gpt-4o', 0.2],
      ['deepseek-v3', 0.8],
      ['claude-3.5', 1],
    ]);
  });

  it('drops out-of-range, non-finite and non-number values instead of applying them', () => {
    const map = parseModelWeightOverrides('{"ok": 0.5, "neg": -1, "big": 3, "nan": "x", "inf": 1e999}');
    expect([...map.entries()]).toEqual([['ok', 0.5]]);
  });

  it('ignores blank, malformed or non-object input', () => {
    expect(parseModelWeightOverrides(undefined).size).toBe(0);
    expect(parseModelWeightOverrides('').size).toBe(0);
    expect(parseModelWeightOverrides('   ').size).toBe(0);
    expect(parseModelWeightOverrides('not json').size).toBe(0);
    expect(parseModelWeightOverrides('42').size).toBe(0);
    expect(parseModelWeightOverrides('[1,2]').size).toBe(0);
  });

  it('accepts the extremes: 0 demotes hard, 2 promotes', () => {
    const map = parseModelWeightOverrides('{"never": 0, "boost": 2}');
    expect(map.get('never')).toBe(0);
    expect(map.get('boost')).toBe(2);
  });

  it('multiplies only the scores of overridden models', () => {
    const overrides = new Map([['gpt-4o', 0.2]]);
    expect(applyModelWeightOverride(0.8, 'gpt-4o', overrides)).toBeCloseTo(0.16);
    expect(applyModelWeightOverride(0.8, 'other-model', overrides)).toBe(0.8);
  });

  it('a zero multiplier zeros the score without disabling the model', () => {
    const overrides = new Map([['slow', 0]]);
    expect(applyModelWeightOverride(0.7, 'slow', overrides)).toBe(0);
    expect(applyModelWeightOverride(0.7, 'fine', overrides)).toBe(0.7);
  });

  it('reads the process env lazily and caches it', () => {
    process.env.MODEL_ROUTING_OVERRIDES = '{"cached": 0.3}';
    expect(getModelWeightOverrides().get('cached')).toBe(0.3);

    // The cache is stable even if the env changes afterwards (fixed at boot).
    process.env.MODEL_ROUTING_OVERRIDES = '{"other": 0.9}';
    expect(getModelWeightOverrides().get('cached')).toBe(0.3);

    // ...and the test seam forgets it so a new value takes effect.
    resetModelWeightOverrides();
    expect(getModelWeightOverrides().get('other')).toBe(0.9);
  });
});
