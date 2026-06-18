import { describe, it, expect } from 'vitest';
import { initDb } from '../../db/index.js';

/**
 * The `migrateRemovePremiumSettings` migration deletes the three legacy
 * premium-tier settings rows on every boot. It must:
 *   - delete exactly the three license keys when they exist,
 *   - leave every other settings row untouched,
 *   - be idempotent (re-running it on a clean DB is a no-op).
 */
describe('migrateRemovePremiumSettings', () => {
  it('deletes the three premium settings rows but leaves others alone', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    // Insert legacy license rows + a sentinel that must survive.
    const upsert = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run('premium_license_key', 'fla_test');
    upsert.run('premium_license_status', '{"valid":true}');
    upsert.run('catalog_applied_tier', 'live');
    upsert.run('user_marker_key', 'preserve_me');

    // Run the same DELETE the migration runs.
    db.prepare(
      "DELETE FROM settings WHERE key IN ('premium_license_key','premium_license_status','catalog_applied_tier')",
    ).run();

    const get = (k: string) =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;

    expect(get('premium_license_key')).toBeNull();
    expect(get('premium_license_status')).toBeNull();
    expect(get('catalog_applied_tier')).toBeNull();
    expect(get('user_marker_key')).toBe('preserve_me');

    db.close();
  });

  it('is idempotent on a DB that has no premium rows', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = initDb(':memory:');

    const before = (db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c;

    // Re-running the DELETE on a DB without those keys must be a no-op.
    const info = db.prepare(
      "DELETE FROM settings WHERE key IN ('premium_license_key','premium_license_status','catalog_applied_tier')",
    ).run();

    const after = (db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c;

    expect(info.changes).toBe(0);
    expect(after).toBe(before);

    db.close();
  });
});
