import { describe, it, expect } from 'vitest';
import { ToolCallAccumulator } from '../../lib/tool-call-accumulator.js';

// #44206: streaming tool_call delta accumulation. Regression case: an upstream
// (Glm) packed TWO complete tool_calls into ONE delta —
//   call 1: {id, index: 0, name: "write", arguments: "{}"}
//   call 2: {id, no index, name: "'\nTC_CLOSE = '", arguments: "{}"}
// The old `index ?? 0` merge welded both into index 0, producing name
// "write'\nTC_CLOSE = '" and arguments "{}{}" which failed JSON.parse, so the
// completedCalls filter dropped the only call and the whole turn read as an
// empty completion ("stream produced no content and no tool calls"),
// needlessly failing the attempt over.

describe('ToolCallAccumulator (#44206)', () => {
  it('splits two complete tool_calls packed into one delta (regression: empty-completion_Glm-5.2_ecb08ba1)', () => {
    const acc = new ToolCallAccumulator();
    // Verbatim shape from the failure dump, chunk 159.
    acc.add({
      id: '89eddd3e-896c-42e0-9a31-5c499626f34a', index: 0,
      function: { name: 'write', arguments: '{}' },
    });
    acc.add({
      id: '3e6c49dc-c7f1-4341-a833-9729f6be5454',
      function: { name: "'\nTC_CLOSE = '", arguments: '{}' },
    });

    const calls = acc.entries();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: '89eddd3e-896c-42e0-9a31-5c499626f34a', name: 'write', args: '{}' });
    expect(calls[1]).toMatchObject({ id: '3e6c49dc-c7f1-4341-a833-9729f6be5454', name: "'\nTC_CLOSE = '", args: '{}' });
    // Each call's arguments parse on their own — the old merged shape
    // ("{}{}") did not, which is what produced the empty completion.
    for (const c of calls) expect(() => JSON.parse(c.args)).not.toThrow();
  });

  it('still merges normal OpenAI-style streamed fragments by index', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '' } });
    acc.add({ index: 0, function: { arguments: '{"city":' } });
    acc.add({ index: 0, function: { arguments: ' "Berlin"}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_a', name: 'get_weather', args: '{"city": "Berlin"}' });
  });

  it('keeps separate accumulator slots for two streamed calls with distinct indexes/ids', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_a', function: { name: 'foo', arguments: '{"x":' } });
    acc.add({ index: 1, id: 'call_b', function: { name: 'bar', arguments: '{"y":' } });
    acc.add({ index: 0, function: { arguments: '1}' } });
    acc.add({ index: 1, function: { arguments: '2}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: 'foo', args: '{"x":1}' });
    expect(calls[1]).toMatchObject({ name: 'bar', args: '{"y":2}' });
  });

  it('extends the same call when the id repeats across deltas', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ id: 'call_x', function: { name: 'f', arguments: '{"a":' } });
    acc.add({ id: 'call_x', function: { arguments: '1}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_x', args: '{"a":1}' });
  });

  it('merges name-first fragments from id-less providers into the indexed call', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, function: { name: 'my_tool', arguments: '' } });
    acc.add({ index: 0, function: { arguments: '{"q": 1}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'my_tool', args: '{"q": 1}' });
  });

  it('routes indexless argument-only fragments to the most recently opened call', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_a', function: { name: 'f', arguments: '{"a":' } });
    // Fragment with no id, no name, no index — the old code sent it to index 0
    // by default; with several open calls it must go to the latest call.
    acc.add({ function: { arguments: '1}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toBe('{"a":1}');
  });

  it('starts a new call for a name-bearing entry with a missing index, even after an indexed call is open', () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: 'call_a', function: { name: 'write', arguments: '{"path": "a"}' } });
    acc.add({ function: { name: 'write', arguments: '{"path": "b"}' } });

    const calls = acc.entries();
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toBe('{"path": "a"}');
    expect(calls[1].args).toBe('{"path": "b"}');
  });

  it('tracks sawDeltas only after a tool_call frame arrived', () => {
    const acc = new ToolCallAccumulator();
    expect(acc.sawDeltas).toBe(false);
    acc.add({ index: 0, function: { arguments: '{}' } });
    expect(acc.sawDeltas).toBe(true);
  });
});