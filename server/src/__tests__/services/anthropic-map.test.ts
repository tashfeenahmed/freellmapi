import { describe, it, expect } from 'vitest';
import { classifyClaudeFamily } from '../../services/anthropic-map.js';

// classifyClaudeFamily maps a requested model alias to a Claude family (or null
// for a concrete catalog id). Claude Code's planning alias `opusplan` is
// opus-ish by name, but the operator map has no `opusplan` slot — it must fall
// through to the `default` family, as the function's own comment states.
describe('classifyClaudeFamily', () => {
  it('routes Claude Code opusplan aliases to the default family', () => {
    expect(classifyClaudeFamily('opusplan')).toBe('default');
    expect(classifyClaudeFamily('opusplan-4')).toBe('default');
    expect(classifyClaudeFamily('OpusPlan')).toBe('default');
  });

  it('still classifies real opus models as the opus family', () => {
    expect(classifyClaudeFamily('opus')).toBe('opus');
    expect(classifyClaudeFamily('claude-opus-4-1')).toBe('opus');
  });

  it('classifies the other Claude families and aliases as before', () => {
    expect(classifyClaudeFamily('claude-sonnet-4-5')).toBe('sonnet');
    expect(classifyClaudeFamily('claude-3-5-haiku')).toBe('haiku');
    expect(classifyClaudeFamily('claude-something-new')).toBe('default');
    expect(classifyClaudeFamily('')).toBe('default');
    expect(classifyClaudeFamily('auto')).toBe('default');
  });

  it('returns null for a non-Claude concrete catalog id', () => {
    expect(classifyClaudeFamily('llama-3.1-70b')).toBeNull();
  });
});
