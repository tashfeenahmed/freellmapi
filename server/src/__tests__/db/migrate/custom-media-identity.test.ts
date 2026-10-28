import { describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../../db/index.js';
import { up, down } from '../../../db/migrations/20261028_000001_custom_media_endpoint_identity.js';

describe('custom media endpoint identity migration', () => {
  it('preserves existing rows and sequence, and refuses a lossy rollback', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    down(db);
    const key = db.prepare(`INSERT INTO api_keys
      (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', 'A', 'e', 'i', 't', 'unknown', 1, 'https://a.example/v1/')`).run();
    const model = db.prepare(`INSERT INTO media_models
      (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
      VALUES ('custom', 'image', 'Image', 'image', 42, 0, 'quota', ?, '{"x":1}')`).run(key.lastInsertRowid);
    const high = db.prepare(`INSERT INTO media_models
      (platform, model_id, display_name, modality) VALUES ('custom', 'deleted', 'Deleted', 'image')`).run();
    db.prepare('DELETE FROM media_models WHERE id = ?').run(high.lastInsertRowid);
    up(db);
    expect(db.prepare('SELECT id, key_id, endpoint_scope, priority, enabled, meta_json FROM media_models WHERE id = ?').get(model.lastInsertRowid))
      .toEqual({ id: Number(model.lastInsertRowid), key_id: Number(key.lastInsertRowid), endpoint_scope: 'https://a.example/v1', priority: 42, enabled: 0, meta_json: '{"x":1}' });
    const second = db.prepare(`INSERT INTO media_models
      (platform, model_id, display_name, modality, endpoint_scope) VALUES ('custom', 'image', 'Image B', 'image', 'https://b.example/v1')`).run();
    expect(Number(second.lastInsertRowid)).toBeGreaterThan(Number(high.lastInsertRowid));
    expect(() => down(db)).toThrow('duplicate model IDs');
    db.prepare('DELETE FROM media_models WHERE id = ?').run(second.lastInsertRowid);
    down(db);
    expect(db.prepare('SELECT key_id, meta_json FROM media_models WHERE id = ?').get(model.lastInsertRowid))
      .toEqual({ key_id: Number(key.lastInsertRowid), meta_json: '{"x":1}' });
  });
});
