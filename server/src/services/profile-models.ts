import type { Db } from '../db/types.js';

export function getActiveProfileId(db: Db): number | null {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (!setting) return null;
  const profileId = parseInt(setting.value, 10);
  if (!Number.isInteger(profileId)) return null;
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as { id: number } | undefined;
  return profile ? profileId : null;
}

// Only chains that still opt in to the backfill (#895). A chain created with
// `empty: true` — or one the operator later switched the flag off on — holds
// exactly what was put in it, and a catalog sync must not quietly refill it.
const AUTO_INCLUDING_PROFILES_SQL = `
  SELECT id FROM profiles WHERE auto_include_new_models = 1 ORDER BY id ASC
`;

export function ensureModelInProfiles(db: Db, modelDbId: number): void {
  const profiles = db.prepare(AUTO_INCLUDING_PROFILES_SQL).all() as { id: number }[];
  const fallback = db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(modelDbId) as { enabled: number } | undefined;
  if (!fallback) return;

  const exists = db.prepare('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?');
  const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?');
  const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');

  for (const profile of profiles) {
    if (exists.get(profile.id, modelDbId)) continue;
    const max = maxPriority.get(profile.id) as { max_priority: number };
    insert.run(profile.id, modelDbId, max.max_priority + 1, fallback.enabled);
  }
}

export function ensureAllModelsInProfiles(db: Db): void {
  const profiles = db.prepare(AUTO_INCLUDING_PROFILES_SQL).all() as { id: number }[];
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

  // One transaction for the whole backfill (#1047): under WAL each bare
  // insert.run() is its own commit + fsync, and profiles × missing models of
  // those, run on the event loop, is how a catalog sync froze every request
  // on the box for minutes on slow storage.
  db.transaction(() => {
    for (const profile of profiles) {
      const rows = missing.all(profile.id) as { id: number; enabled: number }[];
      if (rows.length === 0) continue;
      const max = maxPriority.get(profile.id) as { max_priority: number };
      rows.forEach((row, index) => {
        insert.run(profile.id, row.id, max.max_priority + index + 1, row.enabled);
      });
    }
  })();
}
