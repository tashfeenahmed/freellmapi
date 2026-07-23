import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

const PROFILE_SELECTION_SQL = 'SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?';
const FALLBACK_SELECTION_SQL = 'SELECT enabled FROM fallback_config WHERE model_db_id = ?';
const FUSION_CONFIG_SETTING = 'fusion_config';
const ACTIVE_PROFILE_SQL = "SELECT id FROM profiles WHERE type = 'default' ORDER BY id LIMIT 1";
const INSERT_MODEL_SQL = `
  INSERT INTO models (
    platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled
  ) VALUES (?, ?, ?, ?, ?, ?, 1)
`;
const INSERT_FALLBACK_SQL = 'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)';
const INSERT_PROFILE_MODEL_SQL = 'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)';
const TARGET_MODEL_ID = 'canonical-prune-raw-model';
const TARGET_CANONICAL_ID = 'canonical-prune-target';
const TARGET_DISPLAY_NAME = 'Canonical Prune Target (Test)';
const RETAINED_MODEL_ID = 'canonical-prune-retained-raw-model';
const RETAINED_CANONICAL_ID = 'canonical-prune-retained';
const RETAINED_DISPLAY_NAME = 'Canonical Prune Retained (Test)';
const TEST_MODEL_PLATFORM = 'groq';
const TEST_MODEL_SIZE_LABEL = 'Small';
const TEST_MODEL_INTELLIGENCE_RANK = 9001;
const TEST_MODEL_SPEED_RANK = 9001;
const TARGET_MODEL_PRIORITY = 9001;
const RETAINED_MODEL_PRIORITY = 9002;

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Model management API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('updates catalog model metadata and records durable overrides', async () => {
    const target = getDb().prepare(`
      SELECT id FROM models
       WHERE platform = 'groq' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { id: number };

    const { status, body } = await request(app, 'PATCH', `/api/models/${target.id}`, {
      displayName: 'Locally tuned model',
      supportsTools: true,
      contextWindow: 123456,
      fallbackEnabled: false,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const row = getDb().prepare(`
      SELECT m.display_name, m.supports_tools, m.context_window, fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.id = ?
    `).get(target.id) as { display_name: string; supports_tools: number; context_window: number; fallback_enabled: number };
    expect(row).toEqual({
      display_name: 'Locally tuned model',
      supports_tools: 1,
      context_window: 123456,
      fallback_enabled: 0,
    });

    const override = getDb().prepare('SELECT overrides_json FROM model_overrides WHERE model_id = (SELECT model_id FROM models WHERE id = ?)')
      .get(target.id) as { overrides_json: string };
    expect(JSON.parse(override.overrides_json)).toMatchObject({
      displayName: 'Locally tuned model',
      supportsTools: true,
      contextWindow: 123456,
    });

    const listed = await request(app, 'GET', '/api/models');
    const item = listed.body.find((m: any) => m.id === target.id);
    expect(item.hasOverrides).toBe(true);
    expect(item.fallbackEnabled).toBe(false);
  });

  it('patches a custom model capability directly, without recording a catalog override', async () => {
    // Custom models are not catalog-managed, so their capability edits are
    // written straight to the row (no model_overrides entry to survive syncs).
    const reg = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:6100/v1',
      model: 'cap-edit-model',
    });
    expect(reg.status).toBe(201);
    const modelDbId = reg.body.modelDbId as number;

    const { status, body } = await request(app, 'PATCH', `/api/models/${modelDbId}`, {
      supportsVision: true,
      supportsTools: false,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const row = getDb().prepare('SELECT supports_vision, supports_tools FROM models WHERE id = ?')
      .get(modelDbId) as { supports_vision: number; supports_tools: number };
    expect(row).toEqual({ supports_vision: 1, supports_tools: 0 });

    const override = getDb().prepare("SELECT 1 FROM model_overrides WHERE platform = 'custom' AND model_id = 'cap-edit-model'").get();
    expect(override).toBeUndefined();
  });

  it('disabling a model also clears its fallback/profile/fusion selection (#499)', async () => {
    const db = getDb();
    const profile = db.prepare(ACTIVE_PROFILE_SQL).get() as { id: number };
    const targetInsert = db.prepare(INSERT_MODEL_SQL).run(
      TEST_MODEL_PLATFORM,
      TARGET_MODEL_ID,
      TARGET_DISPLAY_NAME,
      TEST_MODEL_INTELLIGENCE_RANK,
      TEST_MODEL_SPEED_RANK,
      TEST_MODEL_SIZE_LABEL,
    );
    const retainedInsert = db.prepare(INSERT_MODEL_SQL).run(
      TEST_MODEL_PLATFORM,
      RETAINED_MODEL_ID,
      RETAINED_DISPLAY_NAME,
      TEST_MODEL_INTELLIGENCE_RANK + 1,
      TEST_MODEL_SPEED_RANK + 1,
      TEST_MODEL_SIZE_LABEL,
    );
    const target = {
      profile_id: profile.id,
      model_db_id: Number(targetInsert.lastInsertRowid),
      model_id: TARGET_MODEL_ID,
    };
    const retainedModelDbId = Number(retainedInsert.lastInsertRowid);
    db.prepare(INSERT_FALLBACK_SQL).run(target.model_db_id, TARGET_MODEL_PRIORITY);
    db.prepare(INSERT_FALLBACK_SQL).run(retainedModelDbId, RETAINED_MODEL_PRIORITY);
    db.prepare(INSERT_PROFILE_MODEL_SQL).run(profile.id, target.model_db_id, TARGET_MODEL_PRIORITY);
    db.prepare(INSERT_PROFILE_MODEL_SQL).run(profile.id, retainedModelDbId, RETAINED_MODEL_PRIORITY);
    setSetting(FUSION_CONFIG_SETTING, JSON.stringify({
      mode: 'explicit',
      models: [target.model_id, TARGET_CANONICAL_ID, RETAINED_CANONICAL_ID],
      judge: TARGET_CANONICAL_ID,
      k: 2,
      strategy: 'synthesize',
      expose_panel: false,
    }));

    const { status, body } = await request(app, 'PATCH', `/api/models/${target.model_db_id}`, {
      enabled: false,
      fallbackEnabled: true,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const profileSelection = db.prepare(PROFILE_SELECTION_SQL)
      .get(target.profile_id, target.model_db_id) as { enabled: number };
    const fallbackSelection = db.prepare(FALLBACK_SELECTION_SQL)
      .get(target.model_db_id) as { enabled: number };

    expect(profileSelection.enabled).toBe(0);
    expect(fallbackSelection.enabled).toBe(0);

    const savedFusionConfig = JSON.parse(getSetting(FUSION_CONFIG_SETTING)!);
    expect(savedFusionConfig.models).toEqual([RETAINED_CANONICAL_ID]);
    expect(savedFusionConfig.judge).toBeNull();
  });

  it('deletes a catalog model with a tombstone', async () => {
    const target = getDb().prepare(`
      SELECT id, platform, model_id FROM models
       WHERE platform = 'openrouter' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };

    const { status, body } = await request(app, 'DELETE', `/api/models/${target.id}`);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, tombstoned: true });

    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(target.id)).toBeUndefined();
    expect(getDb().prepare(`
      SELECT 1 FROM catalog_model_tombstones
       WHERE kind = 'chat' AND platform = ? AND model_id = ?
    `).get(target.platform, target.model_id)).toBeDefined();
  });
});
