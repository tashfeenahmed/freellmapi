import { describe, it, expect } from 'vitest';
import { repairToolArguments, toolSchemaMap, stripSchemaKeys } from '../../lib/tool-args.js';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    plan: { type: 'array' },
    config: { type: 'object' },
  },
};

describe('repairToolArguments', () => {
  it('decodes an array parameter that arrived as a JSON string (the Codex update_plan case)', () => {
    const broken = JSON.stringify({
      explanation: 'next steps',
      plan: '[{"step": "Review design", "status": "in_progress"}, {"step": "QA", "status": "pending"}]',
    });
    const repaired = JSON.parse(repairToolArguments(broken, PLAN_SCHEMA));
    expect(Array.isArray(repaired.plan)).toBe(true);
    expect(repaired.plan).toHaveLength(2);
    expect(repaired.plan[0].step).toBe('Review design');
    expect(repaired.explanation).toBe('next steps');
  });

  it('decodes an object parameter that arrived as a JSON string', () => {
    const broken = JSON.stringify({ config: '{"retries": 3}' });
    const repaired = JSON.parse(repairToolArguments(broken, PLAN_SCHEMA));
    expect(repaired.config).toEqual({ retries: 3 });
  });

  it('NEVER touches a parameter whose schema type is string, even if it looks like JSON', () => {
    const args = JSON.stringify({ explanation: '["this is literal text the user wants"]' });
    expect(repairToolArguments(args, PLAN_SCHEMA)).toBe(args);
  });

  it('leaves a string alone when it does not parse to the schema type', () => {
    // schema wants array, string parses to an object → mismatch, untouched
    const args = JSON.stringify({ plan: '{"not": "an array"}' });
    expect(repairToolArguments(args, PLAN_SCHEMA)).toBe(args);
  });

  it('leaves non-JSON strings alone', () => {
    const args = JSON.stringify({ plan: 'just do the thing' });
    expect(repairToolArguments(args, PLAN_SCHEMA)).toBe(args);
  });

  it('unwraps whole-arguments double encoding without needing a schema', () => {
    const broken = JSON.stringify(JSON.stringify({ city: 'Berlin' }));
    expect(JSON.parse(repairToolArguments(broken))).toEqual({ city: 'Berlin' });
  });

  it('returns unparseable arguments untouched', () => {
    expect(repairToolArguments('{not json', PLAN_SCHEMA)).toBe('{not json');
    expect(repairToolArguments('', PLAN_SCHEMA)).toBe('');
  });

  it('is a no-op on already-correct arguments', () => {
    const good = JSON.stringify({ plan: [{ step: 'a' }], explanation: 'x' });
    expect(repairToolArguments(good, PLAN_SCHEMA)).toBe(good);
  });

  it('does nothing schema-specific without a schema (beyond whole-args unwrap)', () => {
    const args = JSON.stringify({ plan: '[{"step":"a"}]' });
    expect(repairToolArguments(args)).toBe(args);
  });
});

describe('toolSchemaMap', () => {
  it('maps function tools by name and skips non-function/unnamed entries', () => {
    const map = toolSchemaMap([
      { type: 'function', function: { name: 'f1', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'f2' } },
      { type: 'web_search' } as any,
    ]);
    expect(map.get('f1')).toEqual({ type: 'object' });
    expect(map.has('f2')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('handles undefined tools', () => {
    expect(toolSchemaMap(undefined).size).toBe(0);
  });
});

describe('stripSchemaKeys', () => {
  const keys = new Set(['additionalProperties', '$schema']);

  it('removes the listed keys at the top level', () => {
    const input = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: { city: { type: 'string' } },
    };
    expect(stripSchemaKeys(input, keys)).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
  });

  it('removes the listed keys recursively in nested properties and arrays', () => {
    const input = {
      type: 'object',
      additionalProperties: true,
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: { n: { type: 'number' } },
        },
        list: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: {} },
        },
      },
      anyOf: [{ type: 'string', additionalProperties: false }],
    };
    expect(stripSchemaKeys(input, keys)).toEqual({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { n: { type: 'number' } } },
        list: { type: 'array', items: { type: 'object', properties: {} } },
      },
      anyOf: [{ type: 'string' }],
    });
  });

  it('does not mutate the input (chain-shared schema safety)', () => {
    const input = { type: 'object', additionalProperties: false, properties: {} };
    const copy = JSON.parse(JSON.stringify(input));
    stripSchemaKeys(input, keys);
    expect(input).toEqual(copy);
  });

  it('passes non-object values through unchanged', () => {
    expect(stripSchemaKeys('hi', keys)).toBe('hi');
    expect(stripSchemaKeys(42, keys)).toBe(42);
    expect(stripSchemaKeys(null, keys)).toBe(null);
    expect(stripSchemaKeys(undefined, keys)).toBe(undefined);
  });

  it('keeps a property literally named like a stripped key only when it is a value, not a key', () => {
    // A property whose *value* mentions additionalProperties is untouched;
    // only object KEYS named additionalProperties are removed.
    const input = { type: 'object', properties: { additionalProperties: { type: 'boolean' } } };
    // Here `additionalProperties` is a property NAME nested under `properties`,
    // so it is a schema key and gets stripped — documenting the known limitation.
    expect(stripSchemaKeys(input, keys)).toEqual({ type: 'object', properties: {} });
  });
});
