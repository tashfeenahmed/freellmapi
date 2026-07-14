import type { Db } from '../db/types.js';

export function getActiveProfileId(db: Db): number | null {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (!setting) return null;
  const profileId = parseInt(setting.value, 10);
  if (!Number.isInteger(profileId)) return null;
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as { id: number } | undefined;
  return profile ? profileId : null;
}

export function ensureModelInProfiles(db: Db, modelDbId: number): void {
  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
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
