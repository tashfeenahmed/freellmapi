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

  describe('stream hold-window helpers', () => {
    it('startsWithDialectMarker matches all dialects, with leading whitespace', () => {
      expect(startsWithDialectMarker('<|tool_calls_section_begin|>x')).toBe(true);
      expect(startsWithDialectMarker('  <|tool_call_begin|>')).toBe(true);
      expect(startsWithDialectMarker('\n<tool_call>{}')).toBe(true);
      expect(startsWithDialectMarker('<function=Bash{')).toBe(true);
      expect(startsWithDialectMarker('Hello!')).toBe(false);
      expect(startsWithDialectMarker('<html>')).toBe(false);
    });

    it('couldBecomeDialectMarker holds strict prefixes and releases divergent text', () => {
      expect(couldBecomeDialectMarker('<')).toBe(true);
      expect(couldBecomeDialectMarker('<|to')).toBe(true);
      expect(couldBecomeDialectMarker('<fun')).toBe(true);
      expect(couldBecomeDialectMarker('<tool_ca')).toBe(true);
      expect(couldBecomeDialectMarker('<div')).toBe(false);
      expect(couldBecomeDialectMarker('Hi')).toBe(false);
      // Full marker present is no longer a *prefix* — startsWith takes over.
      expect(couldBecomeDialectMarker('<tool_call>')).toBe(false);
    });

    it('containsDialectMarker finds markers mid-text', () => {
      expect(containsDialectMarker('prose then <function=Read{"a":1}</function>')).toBe(true);
      expect(containsDialectMarker('plain text')).toBe(false);
    });
  });
});
