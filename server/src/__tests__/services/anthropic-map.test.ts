import { describe, it, expect, beforeEach } from 'vitest';
import { classifyClaudeFamily, parseTierSelector, setClaudeModelMap, resolveAnthropicModel } from '../../services/anthropic-map.js';
import { initDb, getDb } from '../../db/index.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

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

// Tier selectors (`tier:pro|mid|normal`) map a Claude family onto the V17
// intelligence tiers (size_label) instead of one pinned model, so the family
// routes over the whole capability band.
describe('tier selectors in the anthropic model map', () => {
  it('parses tier selector values and rejects other strings', () => {
    expect(parseTierSelector('tier:pro')).toBe('tier:pro');
    expect(parseTierSelector('tier:normal')).toBe('tier:normal');
    expect(parseTierSelector('tier:huge')).toBeNull();
    expect(parseTierSelector('auto')).toBeNull();
  });

  it('accepts tier selector values in the map', () => {
    const map = setClaudeModelMap({ opus: 'tier:pro', sonnet: 'tier:mid', haiku: 'tier:normal' });
    expect(map.opus).toBe('tier:pro');
    expect(map.sonnet).toBe('tier:mid');
    expect(map.haiku).toBe('tier:normal');
  });

  it('resolves a tier family to the whole tier pool, unpinned', () => {
    setClaudeModelMap({ opus: 'tier:pro' });
    const resolved = resolveAnthropicModel('claude-opus-4-5');
    expect(resolved.pinned).toBe(false);
    expect(resolved.tierDbIds).toBeDefined();
    expect(resolved.tierDbIds!.length).toBeGreaterThan(0);
    // The whole Frontier tier is one pool: no single model is preferred.
    expect(resolved.preferredModelDbId).toBeUndefined();
  });

  it('normal absorbs Medium and Small so the smallest providers stay reachable', () => {
    setClaudeModelMap({ haiku: 'tier:normal' });
    const resolved = resolveAnthropicModel('claude-haiku-4-5');
    expect(resolved.tierDbIds).toBeDefined();
    expect(resolved.tierDbIds!.length).toBeGreaterThanOrEqual(2);
  });

  it('degrades to auto when the tier pool is empty', () => {
    getDb().prepare(`UPDATE models SET size_label = 'Frontier'`).run();
    setClaudeModelMap({ sonnet: 'tier:mid' });
    const resolved = resolveAnthropicModel('claude-sonnet-4-5');
    expect(resolved).toEqual({ pinned: false });
  });

  it('still pins a concrete catalog model over a tier value', () => {
    const row = getDb().prepare(`SELECT id, model_id FROM models WHERE enabled = 1 LIMIT 1`).get() as { id: number; model_id: string };
    setClaudeModelMap({ opus: row.model_id });
    const resolved = resolveAnthropicModel('claude-opus-4-5');
    expect(resolved.pinned).toBe(true);
    expect(resolved.preferredModelDbId).toBe(row.id);
    expect(resolved.tierDbIds).toBeUndefined();
  });
});
