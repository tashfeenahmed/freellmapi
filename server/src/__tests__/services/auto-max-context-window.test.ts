import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { autoMaxContextWindow, buildModelListing } from '../../services/model-listing.js';
import { ensureModelInProfiles } from '../../services/profile-models.js';

// #2122, #2087: `auto` advertises the window most of the pool holds (#1717),
// so a pool with one 1M model still told Claude Code ~105k. max_context_window
// is the largest prompt auto can still serve for a tool-calling request.

function seedModel(modelId: string, contextWindow: number | null, opts: { tools?: boolean; tpm?: number | null; inChain?: boolean } = {}) {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled,
                        context_window, supports_tools)
    VALUES ('groq', ?, ?, 5, 5, 'Medium', NULL, NULL, ?, NULL, '', 1, ?, ?)
  `).run(modelId, modelId, opts.tpm ?? null, contextWindow, opts.tools === false ? 0 : 1).lastInsertRowid);
  const priority = (db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM fallback_config').get() as { p: number }).p;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)')
    .run(id, priority, opts.inChain === false ? 0 : 1);
  ensureModelInProfiles(db, id);
  if (opts.inChain === false) db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
  return id;
}

function seedKey() {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'k', 'x', 'x', 'x', 'healthy', 1)
  `).run();
}

describe('autoMaxContextWindow (#2122, #2087)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    initDb(':memory:');
    const db = getDb();
    // Start from an empty pool so only the rows below count.
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('is the largest window auto can serve, while context_window stays the median', () => {
    seedModel('small', 131_072);
    seedModel('big', 1_048_576);
    seedKey();
    expect(buildModelListing().autoContextWindow).toBe(104_857); // 131072 / 1.25
    expect(autoMaxContextWindow()).toBe(838_860); // 1048576 / 1.25
  });

  it('is null when no model has a key', () => {
    seedModel('big', 1_048_576);
    expect(autoMaxContextWindow()).toBeNull();
  });

  it('ignores models that cannot take tools or are off in the auto chain', () => {
    seedModel('small', 131_072);
    seedModel('big-no-tools', 1_048_576, { tools: false });
    seedModel('big-off', 1_048_576, { inChain: false });
    seedKey();
    expect(autoMaxContextWindow()).toBe(104_857);
  });

  it('caps a model at its per-minute token limit', () => {
    seedModel('small', 131_072);
    seedModel('big-tpm', 1_048_576, { tpm: 250_000 });
    seedKey();
    expect(autoMaxContextWindow()).toBe(250_000);
  });

  it('honors the operator context floor', () => {
    seedModel('small', 131_072);
    seedModel('mid', 262_144);
    seedKey();
    setSetting('min_context_window', '512k');
    expect(autoMaxContextWindow()).toBeNull();
  });
});
