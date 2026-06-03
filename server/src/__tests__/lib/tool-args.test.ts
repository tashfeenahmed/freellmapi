import { describe, it, expect } from 'vitest';
import { repairToolArguments, toolSchemaMap } from '../../lib/tool-args.js';

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
