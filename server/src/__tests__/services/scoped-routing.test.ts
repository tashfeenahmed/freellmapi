import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { resolveRequestedModel, resolveScopedChain } from '../../services/router.js';

// Covers scoped-model-routing spec: five-step parsing, level/alias expansion,
// group-first ordering, disabled exclusion, case sensitivity, empty scope.
describe('scoped routing (resolveRequestedModel + resolveScopedChain)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    // high-level: glm5.2 (3 members, priority 0) + ds-v4-pro (2 members, priority 1)
    // middle-level: ds-v4-flash (2 members)
    // low-level: disabled-alias (disabled, 1 member) -> should be excluded
    const a = db.prepare('INSERT INTO aliases (name, level, priority, enabled) VALUES (?, ?, ?, 1)');
    a.run('glm5.2', 'high', 0);
    a.run('ds-v4-pro', 'high', 1);
    a.run('ds-v4-flash', 'middle', 0);
    a.run('disabled-alias', 'low', 0);
    db.prepare("UPDATE aliases SET enabled = 0 WHERE name = 'disabled-alias'").run();
    const idOf = (name: string) => (db.prepare('SELECT id FROM aliases WHERE name = ?').get(name) as any).id;
    const glmId = idOf('glm5.2');
    const dsProId = idOf('ds-v4-pro');
    const dsFlashId = idOf('ds-v4-flash');
    const disId = idOf('disabled-alias');
    const m = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, alias_id, alias_priority)
       VALUES ('google', ?, ?, 5, 5, 'Test', 1, ?, ?)`,
    );
    m.run('glm5.2-p1', 'glm5.2 p1', glmId, 0);
    m.run('glm5.2-p2', 'glm5.2 p2', glmId, 1);
    m.run('glm5.2-p3', 'glm5.2 p3', glmId, 2);
    m.run('ds-v4-pro-p1', 'ds pro p1', dsProId, 0);
    m.run('ds-v4-pro-p2', 'ds pro p2', dsProId, 1);
    m.run('ds-v4-flash-p1', 'ds flash p1', dsFlashId, 0);
    m.run('ds-v4-flash-p2', 'ds flash p2', dsFlashId, 1);
    m.run('disabled-p1', 'disabled p1', disId, 0);
    // an enabled=0 member under glm5.2 -> excluded
    db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, alias_id, alias_priority)
       VALUES ('google', 'glm5.2-off', 'off', 5, 5, 'Test', 0, ?, 9)`,
    ).run(glmId);
  });

  it('resolveRequestedModel: auto variants', () => {
    expect(resolveRequestedModel(undefined).kind).toBe('auto');
    expect(resolveRequestedModel('auto').kind).toBe('auto');
    expect(resolveRequestedModel('AUTO').kind).toBe('auto');
    expect(resolveRequestedModel('auto:intelligence').kind).toBe('auto');
  });

  it('resolveRequestedModel: level names case-insensitive', () => {
    expect(resolveRequestedModel('high-level')).toEqual({ kind: 'scoped-level', level: 'high' });
    expect(resolveRequestedModel('High-Level')).toEqual({ kind: 'scoped-level', level: 'high' });
    expect(resolveRequestedModel('MIDDLE-LEVEL')).toEqual({ kind: 'scoped-level', level: 'middle' });
    expect(resolveRequestedModel('low-level')).toEqual({ kind: 'scoped-level', level: 'low' });
  });

  it('resolveRequestedModel: alias name case-sensitive, enabled only', () => {
    expect(resolveRequestedModel('glm5.2')).toEqual({ kind: 'scoped-alias', aliasName: 'glm5.2' });
    // GLM5.2 (different case) is not the alias -> falls through to pinned
    expect(resolveRequestedModel('GLM5.2')).toEqual({ kind: 'pinned', modelId: 'GLM5.2' });
    // disabled alias is not matched -> pinned
    expect(resolveRequestedModel('disabled-alias')).toEqual({ kind: 'pinned', modelId: 'disabled-alias' });
  });

  it('resolveRequestedModel: non-existent name -> pinned', () => {
    expect(resolveRequestedModel('gpt-5')).toEqual({ kind: 'pinned', modelId: 'gpt-5' });
  });

  it('resolveScopedChain: level high expands both aliases in group-first order', () => {
    const chain = resolveScopedChain({ kind: 'scoped-level', level: 'high' });
    const ids = chain.map(c => c.model_id);
    // glm5.2 (alias priority 0) first, its 3 members in alias_priority order,
    // then ds-v4-pro (alias priority 1), its 2 members.
    expect(ids).toEqual([
      'glm5.2-p1', 'glm5.2-p2', 'glm5.2-p3',
      'ds-v4-pro-p1', 'ds-v4-pro-p2',
    ]);
  });

  it('resolveScopedChain: alias expands members in alias_priority order', () => {
    const chain = resolveScopedChain({ kind: 'scoped-alias', aliasName: 'glm5.2' });
    expect(chain.map(c => c.model_id)).toEqual(['glm5.2-p1', 'glm5.2-p2', 'glm5.2-p3']);
  });

  it('resolveScopedChain: excludes disabled aliases and disabled models', () => {
    const lowChain = resolveScopedChain({ kind: 'scoped-level', level: 'low' });
    // disabled-alias is in low but disabled -> empty
    expect(lowChain.map(c => c.model_id)).toEqual([]);
    // glm5.2 alias excludes the enabled=0 member 'glm5.2-off'
    const glmChain = resolveScopedChain({ kind: 'scoped-alias', aliasName: 'glm5.2' });
    expect(glmChain.map(c => c.model_id)).not.toContain('glm5.2-off');
  });

  it('resolveScopedChain: empty scope returns empty array', () => {
    const chain = resolveScopedChain({ kind: 'scoped-alias', aliasName: 'no-such-alias' });
    expect(chain).toEqual([]);
  });
});
