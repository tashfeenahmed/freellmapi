import { describe, it, expect } from 'vitest';
import {
  rescueInlineToolCalls,
  startsWithDialectMarker,
  couldBecomeDialectMarker,
  containsDialectMarker,
} from '../../lib/tool-call-rescue.js';

const TOOLS = new Set(['Read', 'Write', 'Bash', 'Grep', 'list_dir']);

describe('inline tool-call dialect rescue', () => {
  describe('Kimi/DeepSeek token dialect', () => {
    it('parses a well-formed functions.NAME:IDX call', () => {
      const text = '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"/tmp/x.txt"}<|tool_call_end|><|tool_calls_section_end|>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toEqual([{ name: 'Read', arguments: '{"file_path":"/tmp/x.txt"}' }]);
      expect(r.cleanText).toBe('');
    });

    it('parses multiple calls and keeps surrounding prose as cleanText', () => {
      const text = 'Let me check.\n<|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"/a"}<|tool_call_end|><|tool_call_begin|>functions.Grep:1<|tool_call_argument_begin|>{"pattern":"TODO"}<|tool_call_end|>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.calls).toHaveLength(2);
      expect(r.calls![1]).toEqual({ name: 'Grep', arguments: '{"pattern":"TODO"}' });
      expect(r.cleanText).toBe('Let me check.');
    });

    it('reports detected-but-unparseable when the id token is degraded (no function name)', () => {
      // The live capture that motivated this module: an opaque id where
      // functions.NAME:IDX should be — there is no way to know the tool.
      const text = '<|tool_calls_section_begin|> <|tool_call_begin|> chatcmpl-tool-bde5fae954a11b1b <|tool_call_argument_begin|> {"file_path": "/private/tmp/demo-project/src"} <|tool_call_end|>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });

    it('rejects a call naming a tool the request never declared', () => {
      const text = '<|tool_call_begin|>functions.DropTables:0<|tool_call_argument_begin|>{}<|tool_call_end|>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });
  });

  describe('llama/groq <function=> dialect', () => {
    it('parses <function=NAME{json}</function> (the failed_generation shape)', () => {
      const text = '<function=Bash{"command": "npm run build"}</function>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toEqual([{ name: 'Bash', arguments: '{"command": "npm run build"}' }]);
    });

    it('parses the variant with a closing > after the name', () => {
      const text = '<function=Read>{"file_path": "/tmp/a"}</function>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.calls).toEqual([{ name: 'Read', arguments: '{"file_path": "/tmp/a"}' }]);
    });

    it('treats array-shaped arguments as unparseable (live Groq failure shape)', () => {
      const text = '<function=Bash [{"a": "npm run build"}, {"b": "/tmp"}]</function>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });
  });

  describe('Qwen/Hermes <tool_call> XML dialect', () => {
    it('parses a single block with object arguments', () => {
      const text = '<tool_call>\n{"name": "Write", "arguments": {"file_path": "/tmp/n.txt", "content": "hi"}}\n</tool_call>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.calls).toHaveLength(1);
      expect(r.calls![0].name).toBe('Write');
      expect(JSON.parse(r.calls![0].arguments)).toEqual({ file_path: '/tmp/n.txt', content: 'hi' });
    });

    it('accepts the "parameters" key and multiple blocks', () => {
      const text = '<tool_call>{"name": "Read", "parameters": {"file_path": "/a"}}</tool_call><tool_call>{"name": "Grep", "arguments": {"pattern": "x"}}</tool_call>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.calls).toHaveLength(2);
    });

    it('treats a truncated unclosed block as unparseable', () => {
      const text = '<tool_call>{"name": "Read", "argum';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });
  });

  describe('bare / fenced JSON dialect (schema-gated)', () => {
    it('rescues a bare JSON object naming a known tool', () => {
      const r = rescueInlineToolCalls('{"name": "list_dir", "arguments": {"path": "/tmp"}}', TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toEqual([{ name: 'list_dir', arguments: '{"path":"/tmp"}' }]);
    });

    it('rescues a ```json fenced call', () => {
      const r = rescueInlineToolCalls('```json\n{"name": "Bash", "arguments": {"command": "ls"}}\n```', TOOLS);
      expect(r.calls).toHaveLength(1);
    });

    it('does NOT touch ordinary JSON answers that do not name a requested tool', () => {
      const r = rescueInlineToolCalls('{"name": "Tashfeen", "age": 30}', TOOLS);
      expect(r.detected).toBe(false);
      expect(r.cleanText).toBe('{"name": "Tashfeen", "age": 30}');
    });

    it('does NOT touch plain prose', () => {
      const r = rescueInlineToolCalls('The port is 49152, configured in config.json.', TOOLS);
      expect(r.detected).toBe(false);
    });
  });

  describe('dots <dots_function_call> dialect', () => {
    it('parses a well-formed single invoke', () => {
      const text = `<dots_function_call>
  <invoke name="Bash">
    <parameter name="command">echo "TOOL_CALL_SUCCESS"; whoami; pwd</parameter>
  </invoke>
</dots_function_call>`;
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toEqual([{
        name: 'Bash',
        arguments: '{"command":"echo \\"TOOL_CALL_SUCCESS\\"; whoami; pwd"}',
      }]);
      expect(r.cleanText).toBe('');
    });

    it('parses multiple invokes in one wrapper and keeps surrounding prose', () => {
      const text = 'Let me check.\n<dots_function_call>\n  <invoke name="Bash">\n    <parameter name="command">ls</parameter>\n  </invoke>\n  <invoke name="Read">\n    <parameter name="file_path">/tmp/a</parameter>\n  </invoke>\n</dots_function_call>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toEqual([
        { name: 'Bash', arguments: '{"command":"ls"}' },
        { name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
      ]);
      expect(r.cleanText).toBe('Let me check.');
    });

    it('gives JSON-typed values their type (numbers, booleans, arrays, objects)', () => {
      const tools = new Set(['Read', 'Edit', 'TodoWrite']);
      const text = `<dots_function_call>
<invoke name="Read"><parameter name="file_path">/a.ts</parameter><parameter name="offset">10</parameter><parameter name="limit">50</parameter></invoke>
<invoke name="Edit"><parameter name="file_path">/a.ts</parameter><parameter name="old_string">a</parameter><parameter name="new_string">b</parameter><parameter name="replace_all">true</parameter></invoke>
<invoke name="TodoWrite"><parameter name="todos">[{"content":"x","status":"pending"}]</parameter></invoke>
</dots_function_call>`;
      const r = rescueInlineToolCalls(text, tools);
      expect(r.calls?.map((c) => JSON.parse(c.arguments))).toEqual([
        { file_path: '/a.ts', offset: 10, limit: 50 },
        { file_path: '/a.ts', old_string: 'a', new_string: 'b', replace_all: true },
        { todos: [{ content: 'x', status: 'pending' }] },
      ]);
    });

    it('keeps non-JSON text as a string, including text that only looks like JSON', () => {
      const tools = new Set(['Bash', 'Grep']);
      const text = '<dots_function_call><invoke name="Grep"><parameter name="pattern">[a-z]+</parameter><parameter name="path">007x</parameter></invoke><invoke name="Bash"><parameter name="command">{ echo hi; }</parameter></invoke></dots_function_call>';
      const r = rescueInlineToolCalls(text, tools);
      expect(r.calls?.map((c) => JSON.parse(c.arguments))).toEqual([
        { pattern: '[a-z]+', path: '007x' },
        { command: '{ echo hi; }' },
      ]);
    });

    it('keeps a value\'s own whitespace and drops only the line breaks next to the tags', () => {
      const tools = new Set(['Edit']);
      const text = '<dots_function_call><invoke name="Edit">\n<parameter name="old_string">\n    foo()\n  bar()\n</parameter>\n<parameter name="new_string">  baz()  </parameter>\n</invoke></dots_function_call>';
      const r = rescueInlineToolCalls(text, tools);
      expect(JSON.parse(r.calls![0].arguments)).toEqual({
        old_string: '    foo()\n  bar()',
        new_string: '  baz()  ',
      });
    });

    it('rejects a call naming a tool the request never declared', () => {
      const text = '<dots_function_call><invoke name="DropTables"><parameter name="x">1</parameter></invoke></dots_function_call>';
      const r = rescueInlineToolCalls(text, TOOLS);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });
  });

  describe('stream hold-window helpers', () => {
    it('startsWithDialectMarker matches all dialects, with leading whitespace', () => {
      expect(startsWithDialectMarker('<|tool_calls_section_begin|>x')).toBe(true);
      expect(startsWithDialectMarker('  <|tool_call_begin|>')).toBe(true);
      expect(startsWithDialectMarker('\n<tool_call>{}')).toBe(true);
      expect(startsWithDialectMarker('<function=Bash{')).toBe(true);
      expect(startsWithDialectMarker('<dots_function_call>')).toBe(true);
      expect(startsWithDialectMarker('  <dots_function_call>\n')).toBe(true);
      expect(startsWithDialectMarker('Hello!')).toBe(false);
      expect(startsWithDialectMarker('<html>')).toBe(false);
    });

    it('couldBecomeDialectMarker holds strict prefixes and releases divergent text', () => {
      expect(couldBecomeDialectMarker('<')).toBe(true);
      expect(couldBecomeDialectMarker('<|to')).toBe(true);
      expect(couldBecomeDialectMarker('<fun')).toBe(true);
      expect(couldBecomeDialectMarker('<tool_ca')).toBe(true);
      expect(couldBecomeDialectMarker('<dots_fun')).toBe(true);
      expect(couldBecomeDialectMarker('<div')).toBe(false);
      expect(couldBecomeDialectMarker('Hi')).toBe(false);
      // Full marker present is no longer a *prefix* — startsWith takes over.
      expect(couldBecomeDialectMarker('<tool_call>')).toBe(false);
      expect(couldBecomeDialectMarker('<dots_function_call>')).toBe(false);
    });

    it('containsDialectMarker finds markers mid-text', () => {
      expect(containsDialectMarker('prose then <function=Read{"a":1}</function>')).toBe(true);
      expect(containsDialectMarker('prose then <dots_function_call>')).toBe(true);
      expect(containsDialectMarker('plain text')).toBe(false);
    });
  });

  // A turn that declared no tools has nothing callable, so no name can be
  // "known". The gate used to read `toolNames.size === 0 || has(name)`, which
  // meant the empty set matched EVERY name: prose that merely looked like a
  // dialect was reconstructed into tool_calls the caller never asked for and
  // cannot interpret.
  describe('an empty tool set makes nothing callable', () => {
    const EMPTY = new Set<string>();

    it('does not synthesize a call from the function-tag dialect', () => {
      const out = rescueInlineToolCalls('<function=Bash{"command":"rm -rf /"}</function>', EMPTY);
      expect(out.calls).toBeNull();
    });

    it('does not synthesize a call from the Kimi/DeepSeek token dialect', () => {
      const text = '<|tool_call_begin|>functions.Bash:0<|tool_call_argument_begin|>{"command":"ls"}<|tool_call_end|>';
      expect(rescueInlineToolCalls(text, EMPTY).calls).toBeNull();
    });

    it('does not synthesize a call from the Qwen/Hermes XML dialect', () => {
      const text = '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>';
      expect(rescueInlineToolCalls(text, EMPTY).calls).toBeNull();
    });

    it('does not synthesize a call from the dots XML dialect', () => {
      const text = '<dots_function_call><invoke name="Bash"><parameter name="command">ls</parameter></invoke></dots_function_call>';
      const r = rescueInlineToolCalls(text, EMPTY);
      expect(r.detected).toBe(true);
      expect(r.calls).toBeNull();
    });

    it('still rescues the same text when the tool WAS declared', () => {
      const out = rescueInlineToolCalls('<function=Bash{"command":"ls"}</function>', TOOLS);
      expect(out.calls).toEqual([{ name: 'Bash', arguments: '{"command":"ls"}' }]);
    });
  });
});
