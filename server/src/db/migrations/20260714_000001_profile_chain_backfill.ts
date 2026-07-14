import type { Db } from '../types.js';

const DOWNGRADE_MARKER_KEY = 'profile_chain_backfill_downgraded';

/**
 * The router prefers the active profile's `profile_models` chain, while the
 * visible Models page historically edited `fallback_config`. New rows added by
 * catalog sync or custom providers were therefore missing from the hidden active
 * profile and never entered auto routing. Backfill every profile with any model
 * rows it lacks, preserving the current fallback_config enabled flag for the
 * initial auto-routing state.
 */
export function up(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(DOWNGRADE_MARKER_KEY);

  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  if (profiles.length === 0) return;

  const missing = db.prepare(`
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE pm.id IS NULL
     ORDER BY f.priority, m.id
  `);
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?');
  const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

  for (const profile of profiles) {
    const rows = missing.all(profile.id) as { id: number; enabled: number }[];
    if (rows.length === 0) continue;
    const max = maxPriority.get(profile.id) as { max_priority: number };
    rows.forEach((row, index) => {
      insert.run(profile.id, row.id, max.max_priority + index + 1, row.enabled);
    });
  }
}

export function down(db: Db): void {
  // Removing rows on downgrade would discard user-managed profile order and
  // enabled state. Older app versions ignore this marker, and the next upgrade
  // removes it before re-running the backfill.
  db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(DOWNGRADE_MARKER_KEY);
}
