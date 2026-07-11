import { describe, it, expect } from 'vitest';
import { enforceJsonContent } from '../../lib/structured-output.js';

describe('enforceJsonContent', () => {
  it('passes clean JSON through untouched', () => {
    const r = enforceJsonContent('{"city":"Paris","pop":2100000}');
    expect(r).toEqual({ ok: true, content: '{"city":"Paris","pop":2100000}', healed: false });
  });

  it('accepts JSON arrays and scalars (valid json_object outputs vary)', () => {
    expect(enforceJsonContent('[1,2,3]').ok).toBe(true);
    expect(enforceJsonContent('  {"a":1}  ')).toMatchObject({ ok: true, healed: true }); // trimmed = healed
  });

  it('heals a ```json fenced block', () => {
    const r = enforceJsonContent('Here you go:\n```json\n{"answer": 42}\n```\nHope that helps!');
    expect(r).toEqual({ ok: true, content: '{"answer": 42}', healed: true });
  });

  it('heals a bare ``` fence', () => {
    const r = enforceJsonContent('```\n{"answer": 42}\n```');
    expect(r).toEqual({ ok: true, content: '{"answer": 42}', healed: true });
  });

  it('heals prose-wrapped JSON ("Here is your JSON: {...}")', () => {
    const r = enforceJsonContent('Sure! Here is the requested JSON: {"name":"Ada","tags":["a","b"]} Let me know if you need more.');
    expect(r).toEqual({ ok: true, content: '{"name":"Ada","tags":["a","b"]}', healed: true });
  });

  it('rejects pure prose', () => {
    expect(enforceJsonContent('The city you asked about is Paris, which has about 2.1M people.')).toEqual({ ok: false });
  });

  it('rejects broken JSON that cannot be healed', () => {
    expect(enforceJsonContent('{"city": "Paris", "pop": }')).toEqual({ ok: false });
    expect(enforceJsonContent('```json\n{"unclosed": true\n```')).toEqual({ ok: false });
  });

  it('rejects empty content', () => {
    expect(enforceJsonContent('')).toEqual({ ok: false });
    expect(enforceJsonContent('   ')).toEqual({ ok: false });
  });

  it('JSON containing braces inside strings survives the slice heuristic', () => {
    const clean = '{"code":"if (a) { return b; }"}';
    expect(enforceJsonContent(`prefix ${clean} suffix`)).toEqual({ ok: true, content: clean, healed: true });
  });
});
