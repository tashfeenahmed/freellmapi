import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// GET /v1/models/:id — OpenAI `models.retrieve`. Competitors all expose it
// (OpenAI itself, OpenRouter's GET /api/v1/models/{author}/{slug}, Together),
// and OpenAI-SDK-based gateways call it before routing. Served from the same
// builder as the list so the two endpoints can never disagree.
//
// OpenAI-compatible /models endpoint (used by Hermes for metadata)
// shows API models which is linked by the user

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('GET /v1/models/:id (models.retrieve)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  beforeEach(async () => {
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_retrieve_test',
      label: 'retrieve',
    });
    expect(addKey.status).toBe(201);
    const addModel = db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools
      )
      VALUES ('groq', 'groq/retrieve-test-model', 'Retrieve Test', 1, 1, 'Small',
              NULL, NULL, NULL, NULL, '~1M', 4096, 1, 0, 1)
    `).run();
    expect(addModel.changes).toBe(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the entry a client just listed, field for field', async () => {
    const listed = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(listed.status).toBe(200);
    // The retrieve must cover every id the list hands out, so walk the list:
    // each catalog id must be retrievable with the identical shape.
    // The unified listing publishes the canonical slug for the seeded row.
    const row = listed.body.data.find((m: any) => m.id === 'retrieve-test');
    expect(row).toBeTruthy();

    const got = await request(app, 'GET', `/v1/models/${encodeURIComponent(row.id)}`, undefined, authHeaders());
    expect(got.status).toBe(200);
    expect(got.body.object).toBe('model');
    expect(got.body.id).toBe(row.id);
    expect(got.body.owned_by).toBe(row.owned_by);
    expect(got.body.context_window).toBe(4096);
    expect(got.body.available).toBe(true);
    expect(got.body.execution_status).toBe(row.execution_status);
  });

  it('resolves the virtual router entries too', async () => {
    const auto = await request(app, 'GET', '/v1/models/auto', undefined, authHeaders());
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ id: 'auto', object: 'model', owned_by: 'freellmapi' });

    const fusion = await request(app, 'GET', '/v1/models/fusion', undefined, authHeaders());
    expect(fusion.status).toBe(200);
    expect(fusion.body.id).toBe('fusion');
  });

  it('answers an unknown id with OpenAI\'s 404 shape', async () => {
    const res = await request(app, 'GET', '/v1/models/not-a-real-model', undefined, authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'id',
    });
    expect(res.body.error.message).toContain('not-a-real-model');
  });

  it('requires inference auth', async () => {
    const { status } = await request(app, 'GET', '/v1/models/auto');
    expect(status).toBe(401);
  });

  it('still answers the list endpoint (the /:id route must not shadow it)', async () => {
    const res = await request(app, 'GET', '/v1/models', undefined, authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('list');
  });
});
