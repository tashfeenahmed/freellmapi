import type { Db } from '../types.js';

// Model table inlined (not imported from the provider): migrations must be
// self-contained snapshots — importing live provider code would let future
// edits rewrite history for existing installs.
const MODELS: Array<{ id: string; name: string; contextWindow: number; vision: boolean }> = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576, vision: true },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1048576, vision: true },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1048576, vision: true },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, vision: true },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', contextWindow: 1048576, vision: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, vision: true },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000, vision: true },
  { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', contextWindow: 131072, vision: false },
];
const RANKS: Record<string, [number, number, string]> = {
  'gemini-3.8-flash': [6, 4, 'Frontier'],
  'gemini-3.7-flash': [7, 4, 'Frontier'],
  'gemini-3.6-flash': [8, 4, 'Large'],
  'gemini-3.5-flash': [9, 4, 'Large'],
  'gemini-3.1-pro': [5, 4, 'Frontier'],
  'claude-sonnet-4-6': [4, 4, 'Frontier'],
  'claude-opus-4-6': [3, 4, 'Frontier'],
  'gpt-oss-120b': [14, 4, 'Large'],
};

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apply = db.transaction(() => {
    for (const m of MODELS) {
      const [intel, speed, size] = RANKS[m.id] ?? [20, 4, 'Large'];
      insert.run('antigravity', m.id, `${m.name} (Antigravity)`, intel, speed, size,
        null, null, null, null, 'oauth · account quota', m.contextWindow, 0,
        m.vision ? 1 : 0, 1);
    }
    // Disabled seed: login enables. Re-assert display metadata on re-run
    // (INSERT OR IGNORE is a no-op for existing rows); never flip enabled.
    const reassert = db.prepare(`
      UPDATE models SET display_name = ?, intelligence_rank = ?, speed_rank = ?, size_label = ?,
        context_window = ?, supports_vision = ?, supports_tools = ?
      WHERE platform = 'antigravity' AND model_id = ?
    `);
    for (const m of MODELS) {
      const [intel, speed, size] = RANKS[m.id] ?? [20, 4, 'Large'];
      reassert.run(`${m.name} (Antigravity)`, intel, speed, size, m.contextWindow,
        m.vision ? 1 : 0, 1, m.id);
    }
    // Chain rows for the seeded models (scoped: this platform only).
    const missing = db.prepare(`
      SELECT m.id FROM models m LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL AND m.platform = 'antigravity' ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
    backfillProfiles(db);
    // Quirk: per-user OAuth gate (fixed id 1002, continuing 1000/1001).
    db.prepare(`
      INSERT OR REPLACE INTO quirks (id, slug, title, body, severity, created_at_ms, updated_at_ms)
      VALUES (1002, 'antigravity-oauth-required', 'Google login required',
        'antigravity models need a per-user Google OAuth login (JSON blob credential via /api/antigravity/exchange); rows stay disabled until login enables them. One key row per Google account; router failover covers account failover.',
        'warning', 1788307200000, 1788307200000)
    `).run();
    db.prepare(`DELETE FROM quirk_targets WHERE quirk_id = 1002`).run();
    db.prepare(`INSERT INTO quirk_targets (id, quirk_id, platform, model_glob) VALUES (1002, 1002, 'antigravity', NULL)`).run();
  });
  apply();
}

export function down(db: Db): void {
  db.prepare(`UPDATE fallback_config SET enabled = 0 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'antigravity')`).run();
  db.prepare(`UPDATE profile_models SET enabled = 0 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'antigravity')`).run();
  db.prepare(`UPDATE models SET enabled = 0 WHERE platform = 'antigravity'`).run();
  // Deleting the fixed-id quirk alters state for the roundtrip check while
  // re-up restores the exact same fixed id (1002), preserving bit-for-bit stability.
  db.prepare(`DELETE FROM quirk_targets WHERE quirk_id = 1002`).run();
  db.prepare(`DELETE FROM quirks WHERE id = 1002`).run();
}

function backfillProfiles(db: Db) {
  const profiles = db.prepare('SELECT id FROM profiles ORDER BY id ASC').all() as { id: number }[];
  const missing = db.prepare(`
    SELECT m.id, f.enabled, f.priority
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE pm.id IS NULL AND m.platform = 'antigravity'
     ORDER BY f.priority ASC
  `);
  const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
  for (const profile of profiles) {
    const rows = missing.all(profile.id) as { id: number; enabled: number; priority: number }[];
    for (const r of rows) insert.run(profile.id, r.id, r.priority, r.enabled);
  }
}
