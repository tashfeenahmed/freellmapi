import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { MODELS_READY_ONLY_SETTING } from '../../services/model-listing.js';
import { setCooldown } from '../../services/ratelimit.js';

// #2051: a dashboard switch turns `?execution_status=ready` into the answer to
// a bare GET /v1/models, so clients that cannot send a query parameter (Open
// WebUI's model picker) stop offering models whose keys are all on cooldown.
// Any explicit filter still wins, and the switch is off by default.

let app: Express;
let dashToken = '';
let keySeq = 0;

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await response.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON */ }
  return { status: response.status, body: json };
}

function inferenceHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function dashboardHeaders() {
  return { Authorization: `Bearer ${dashToken}` };
}

function seedModel(platform: string, modelId: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 5, 5, 'Medium', NULL, NULL, NULL, NULL, '', 1)
  `).run(platform, modelId, modelId);
}

function seedKey(platform: string, status: string) {
  keySeq += 1;
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, ?, 'x', 'x', 'x', ?, 1, NULL)
  `).run(platform, `${platform}-${keySeq}`, status).lastInsertRowid);
}

async function setReadyOnly(readyOnly: boolean) {
  const response = await request('PUT', '/api/settings/models-ready-only', { readyOnly }, dashboardHeaders());
  expect(response.status).toBe(200);
  return response.body;
}

async function listModels(query = '') {
  const response = await request('GET', `/v1/models${query}`, undefined, inferenceHeaders());
  expect(response.status).toBe(200);
  return response.body.data as Array<{ id: string; execution_status?: string }>;
}

function catalogIds(rows: Array<{ id: string; execution_status?: string }>) {
  return rows.filter(row => row.execution_status !== undefined).map(row => row.id).sort();
}

describe('GET /v1/models ready-only default (#2051)', () => {
  let readyKeyId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    // The baseline seeds a default profile and fallback rows that point at the
    // catalog; drop those first so the model table can be emptied.
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM settings WHERE key = ?').run(MODELS_READY_ONLY_SETTING);

    seedModel('groq', 'ready-model');
    readyKeyId = seedKey('groq', 'healthy');
    seedModel('openai', 'exhausted-model');
    seedKey('openai', 'invalid');
    seedModel('anthropic', 'needs-key-model');
  });

  it('lists the whole catalog by default', async () => {
    expect(await request('GET', '/api/settings/models-ready-only', undefined, dashboardHeaders()))
      .toMatchObject({ status: 200, body: { readyOnly: false } });

    const rows = await listModels();
    expect(rows[0].id).toBe('auto');
    expect(catalogIds(rows)).toEqual(['exhausted-model', 'needs-key-model', 'ready-model']);
  });

  it('narrows a bare request to ready models once the switch is on', async () => {
    expect(await setReadyOnly(true)).toEqual({ readyOnly: true });

    const rows = await listModels();
    expect(rows.map(row => row.id)).toContain('auto');
    expect(catalogIds(rows)).toEqual(['ready-model']);
    expect(rows.find(row => row.id === 'ready-model')?.execution_status).toBe('ready');
  });

  it('lets an explicit filter override the stored default', async () => {
    await setReadyOnly(true);

    const needsKey = await listModels('?execution_status=needsKey');
    expect(catalogIds(needsKey)).toEqual(['needs-key-model']);

    const available = await listModels('?available=true');
    expect(catalogIds(available)).toEqual(['exhausted-model', 'ready-model']);

    // An unrecognised value filters nothing, and still counts as explicit: it
    // must not fall back to the stored default.
    const bogus = await listModels('?execution_status=banana');
    expect(catalogIds(bogus)).toEqual(['exhausted-model', 'needs-key-model', 'ready-model']);
  });

  it('omits router entries when nothing can serve a request', async () => {
    await setReadyOnly(true);
    setCooldown('groq', 'ready-model', readyKeyId, 60_000, 'header');

    expect(await listModels()).toEqual([]);
  });

  it('restores the full catalog when the switch is turned off', async () => {
    await setReadyOnly(true);
    expect(await setReadyOnly(false)).toEqual({ readyOnly: false });

    expect(catalogIds(await listModels())).toEqual(['exhausted-model', 'needs-key-model', 'ready-model']);
  });

  it('rejects a body that is not a boolean', async () => {
    const response = await request('PUT', '/api/settings/models-ready-only', { readyOnly: 'yes' }, dashboardHeaders());
    expect(response.status).toBe(400);
  });
});
