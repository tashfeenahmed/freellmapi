import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { deleteChatModel } from '../../services/model-state.js';

function addCustomKey(baseUrl: string): number {
  const inserted = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'endpoint', 'enc', 'iv', 'tag', 'healthy', 1, ?)
  `).run(baseUrl);
  return Number(inserted.lastInsertRowid);
}

function addModel(partial: {
  platform: string;
  modelId: string;
  keyId?: number | null;
  source?: string;
}): number {
  const inserted = getDb().prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id, source)
    VALUES (?, ?, ?, 100, 100, 'Small', 1, ?, ?)
  `).run(partial.platform, partial.modelId, partial.modelId, partial.keyId ?? null, partial.source ?? 'catalog');
  const id = Number(inserted.lastInsertRowid);
  getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  return id;
}

function rowCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('deleteChatModel', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
  });

  it('returns undefined and writes nothing for a missing id', () => {
    expect(deleteChatModel(getDb(), 999999)).toBeUndefined();
  });

  it('returns undefined and keeps the row when onlyPlatform does not match', () => {
    const id = addModel({ platform: 'groq', modelId: 'm' });
    expect(deleteChatModel(getDb(), id, 'custom')).toBeUndefined();
    expect(rowCount('models')).toBe(1);
    expect(rowCount('fallback_config')).toBe(1);
  });

  it('tombstones a catalog row as user-deleted and drops its chain entry', () => {
    const id = addModel({ platform: 'groq', modelId: 'm' });
    const result = getDb().transaction(() => deleteChatModel(getDb(), id))();

    expect(result).toMatchObject({ tombstoned: 'catalog', platform: 'groq', modelId: 'm' });
    expect(rowCount('models')).toBe(0);
    expect(rowCount('fallback_config')).toBe(0);
    const tomb = getDb().prepare(
      "SELECT source FROM catalog_model_tombstones WHERE kind = 'chat' AND platform = 'groq' AND model_id = 'm'",
    ).get() as { source: string } | undefined;
    expect(tomb?.source).toBe('user');
  });

  it('tombstones a custom row by endpoint scope and sweeps the unused key', () => {
    const keyId = addCustomKey('https://relay.example.com/v1');
    const id = addModel({ platform: 'custom', modelId: 'm', keyId, source: 'user' });
    const result = getDb().transaction(() => deleteChatModel(getDb(), id))();

    expect(result?.tombstoned).toBe('custom');
    expect(rowCount('models')).toBe(0);
    expect(rowCount('fallback_config')).toBe(0);
    expect(rowCount('api_keys')).toBe(0);
    const tomb = getDb().prepare(
      'SELECT 1 AS x FROM custom_model_tombstones WHERE model_id = ?',
    ).get('m') as { x: number } | undefined;
    expect(tomb).toBeDefined();
  });

  it('records no tombstone for a user-source row', () => {
    const id = addModel({ platform: 'groq', modelId: 'm', source: 'user' });
    const result = getDb().transaction(() => deleteChatModel(getDb(), id))();

    expect(result?.tombstoned).toBeNull();
    expect(rowCount('models')).toBe(0);
    expect(rowCount('catalog_model_tombstones')).toBe(0);
  });
});
