import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getSetting, setSetting, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { applyAllModelOverrides } from '../../services/model-state.js';

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
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  // /v1/* inference endpoints authenticate with the unified key (or a client
  // profile key), NOT the dashboard token; /api/* admin endpoints take the
  // dashboard token. isGatedApiPath covers the admin side, and /v1 paths are
  // simply excluded from it — so add the unified key explicitly for those.
  const isV1 = path.startsWith('/v1/');
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...(isV1 ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('persists rank and rate-limit edits as overrides that survive a catalog re-apply (#551)', async () => {
    const target = getDb().prepare(`
      SELECT m.id, m.platform, m.model_id FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = 'groq' AND m.key_id IS NULL AND m.source != 'user'
       ORDER BY m.id DESC LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };

    const edits = {
      intelligenceRank: 7,
      speedRank: 11,
      rpmLimit: 13,
      rpdLimit: 17,
      tpmLimit: 19,
      tpdLimit: 23,
    };
    const { status } = await request(app, 'PATCH', `/api/models/${target.id}`, edits);
    expect(status).toBe(200);

    const readColumns = () => getDb().prepare(`
      SELECT intelligence_rank, speed_rank, rpm_limit, rpd_limit, tpm_limit, tpd_limit
        FROM models WHERE id = ?
    `).get(target.id);
    const expectedColumns = {
      intelligence_rank: 7, speed_rank: 11,
      rpm_limit: 13, rpd_limit: 17, tpm_limit: 19, tpd_limit: 23,
    };
    expect(readColumns()).toEqual(expectedColumns);

    const override = getDb().prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
      .get(target.platform, target.model_id) as { overrides_json: string };
    expect(JSON.parse(override.overrides_json)).toMatchObject(edits);

    // A catalog sync rewrites every catalog-owned column before the overrides
    // are re-applied, so simulate the rewrite and check the edits come back.
    getDb().prepare(`
      UPDATE models SET intelligence_rank = 500, speed_rank = 500, rpm_limit = NULL,
                        rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL
       WHERE id = ?
    `).run(target.id);
    expect(applyAllModelOverrides(getDb())).toBeGreaterThan(0);
    expect(readColumns()).toEqual(expectedColumns);

    // Per-field provenance, so the model page can mark the overridden inputs.
    const listed = await request(app, 'GET', '/api/models');
    const item = listed.body.find((m: any) => m.id === target.id);
    expect(item.overrideFields).toEqual(expect.arrayContaining(Object.keys(edits)));
    expect(item.intelligenceRank).toBe(7);
    expect(item.speedRank).toBe(11);

    const chain = await request(app, 'GET', '/api/fallback');
    const entry = chain.body.find((e: any) => e.modelDbId === target.id);
    expect(entry.overrideFields).toEqual(expect.arrayContaining(Object.keys(edits)));
    expect(entry.tpmLimit).toBe(19);
    expect(entry.tpdLimit).toBe(23);
  });

  it('clears a rate limit back to unlimited with an explicit null (#551)', async () => {
    const target = getDb().prepare(`
      SELECT m.id, m.platform, m.model_id FROM models m
       WHERE m.platform = 'cerebras' AND m.key_id IS NULL AND m.source != 'user'
       ORDER BY m.id LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };

    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { rpmLimit: 41 })).status).toBe(200);
    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { rpmLimit: null })).status).toBe(200);

    const row = getDb().prepare('SELECT rpm_limit FROM models WHERE id = ?').get(target.id) as { rpm_limit: number | null };
    expect(row.rpm_limit).toBeNull();

    // The null has to be stored too, or the next catalog sync would put the
    // catalog's limit back.
    const override = getDb().prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
      .get(target.platform, target.model_id) as { overrides_json: string };
    expect(JSON.parse(override.overrides_json).rpmLimit).toBeNull();

    getDb().prepare('UPDATE models SET rpm_limit = 99 WHERE id = ?').run(target.id);
    applyAllModelOverrides(getDb());
    expect((getDb().prepare('SELECT rpm_limit FROM models WHERE id = ?').get(target.id) as any).rpm_limit).toBeNull();
  });

  it("clears the capability tier back to unscored with an empty sizeLabel (#685)", async () => {
    const target = getDb().prepare(`
      SELECT m.id, m.platform, m.model_id FROM models m
       WHERE m.platform = 'groq' AND m.key_id IS NULL AND m.source != 'user'
       ORDER BY m.id LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };

    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { sizeLabel: 'Frontier' })).status).toBe(200);
    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { sizeLabel: '' })).status).toBe(200);

    const row = getDb().prepare('SELECT size_label FROM models WHERE id = ?').get(target.id) as { size_label: string };
    expect(row.size_label).toBe('');

    // The '' has to be stored as an override too, or the next catalog sync
    // would put the catalog's tier back.
    const override = getDb().prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
      .get(target.platform, target.model_id) as { overrides_json: string };
    expect(JSON.parse(override.overrides_json).sizeLabel).toBe('');

    getDb().prepare("UPDATE models SET size_label = 'Large' WHERE id = ?").run(target.id);
    applyAllModelOverrides(getDb());
    expect((getDb().prepare('SELECT size_label FROM models WHERE id = ?').get(target.id) as any).size_label).toBe('');
  });

  it('rejects an out-of-range intelligence rank (#551)', async () => {
    const target = getDb().prepare(`
      SELECT id FROM models WHERE platform = 'groq' AND key_id IS NULL ORDER BY id LIMIT 1
    `).get() as { id: number };

    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { intelligenceRank: 0 })).status).toBe(400);
    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { speedRank: 1001 })).status).toBe(400);
    expect((await request(app, 'PATCH', `/api/models/${target.id}`, { rpmLimit: 0 })).status).toBe(400);
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

  // The named-chain listing and routing tests below need a live groq key: a
  // chain is only "available" when one of its members can serve a request now.
  function seedGroqKey(): void {
    const secret = encrypt('gsk_named_chain_test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'named-chain', ?, ?, ?, 'healthy', 1)
    `).run(secret.encrypted, secret.iv, secret.authTag);
  }

  // A model that exists ONLY inside the custom profile, so "the served model is
  // this one" proves the request went through the named chain rather than the
  // active/default chain.
  function seedChainOnlyModel(modelId: string, contextWindow: number): number {
    const inserted = getDb().prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        context_window, enabled, supports_tools
      ) VALUES ('groq', ?, ?, 100, 100, 'Small', ?, 1, 1)
    `).run(modelId, `Named chain ${modelId}`, contextWindow);
    return Number(inserted.lastInsertRowid);
  }

  function newProfile(name: string, sortOrder: number): number {
    const inserted = getDb().prepare(`
      INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES (?, '', '#6366f1', 'custom', ?)
    `).run(name, sortOrder);
    return Number(inserted.lastInsertRowid);
  }

  function addToProfile(profileId: number, modelDbId: number, enabled = 1): void {
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, ?)')
      .run(profileId, modelDbId, enabled);
  }

  it('exposes custom profiles as auto:<name> chains in /v1/models (#960/#895)', async () => {
    seedGroqKey();

    // A chain whose single member is enabled and backed by an enabled key.
    const servableId = seedChainOnlyModel('named-chain-servable', 111000);
    addToProfile(newProfile('my-group', 5), servableId);

    // A chain whose single member is switched off in the chain: nothing in it
    // can serve a request, so the entry must say so rather than claim ready.
    const prunedId = seedChainOnlyModel('named-chain-pruned', 222000);
    addToProfile(newProfile('off-group', 6), prunedId, 0);

    const listed = await request(app, 'GET', '/v1/models');
    expect(listed.status).toBe(200);

    const chain = listed.body.data.find((m: any) => m.id === 'auto:my-group');
    expect(chain).toBeDefined();
    expect(chain.name).toContain('my-group');
    expect(chain.object).toBe('model');
    expect(chain.owned_by).toBe('freellmapi');
    // The real point of the entry: is this chain usable right now, and how big
    // a context can it take? Both are asserted, not merely present.
    expect(chain.available).toBe(true);
    expect(chain.unavailable_reason).toBeNull();
    expect(chain.context_window).toBe(111000);
    expect(chain.context_length).toBe(111000);

    const off = listed.body.data.find((m: any) => m.id === 'auto:off-group');
    expect(off).toBeDefined();
    expect(off.available).toBe(false);
    expect(off.unavailable_reason).toBe('no_models');

    // The virtual auto: id must not collide with real catalog ids.
    expect(listed.body.data.filter((m: any) => m.id === 'auto:my-group')).toHaveLength(1);
  });

  it('lists the Claude family ids on the plain OpenAI /v1/models too (#880)', async () => {
    // routes/anthropic.ts only answers GET /v1/models when the caller sends an
    // `anthropic-version` header. Claude Desktop's gateway picker does not, so
    // the OpenAI-shaped listing has to carry the same Claude-shaped ids or the
    // picker reports "found 0 models".
    const listed = await request(app, 'GET', '/v1/models');
    expect(listed.status).toBe(200);

    for (const id of ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      const entry = listed.body.data.find((m: any) => m.id === id);
      expect(entry, `${id} must be listed`).toBeDefined();
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('freellmapi');
      expect(entry.available).toBe(true);
      // The display name says where the request really goes — none of these is
      // hosted Claude.
      expect(entry.name).toMatch(/slot/);
    }

    // Still one row per id.
    const ids = listed.body.data.map((m: any) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('routes a request to model auto:<name> through that named chain (#960/#895)', async () => {
    const chainOnlyId = seedChainOnlyModel('named-chain-routed', 128000);
    addToProfile(newProfile('route-group', 7), chainOnlyId);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({
            id: 'chatcmpl-chain', object: 'chat.completion', created: 1, model: 'named-chain-routed',
            choices: [{ index: 0, message: { role: 'assistant', content: 'routed via route-group' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const routed = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto:route-group',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(routed.status).toBe(200);
    expect(routed.body.choices[0].message.content).toBe('routed via route-group');

    // The served model is the one that exists ONLY in this profile, so the
    // request really went down the named chain and not the active one.
    const served = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1')
      .get() as { model_id: string } | undefined;
    expect(served?.model_id).toBe('named-chain-routed');

    // An unknown chain name must fail loudly, not silently fall back to the
    // active chain.
    const missing = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto:no-such-group',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain('no-such-group');
  });
});
