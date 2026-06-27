import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
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

  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// requested_model logging: a pinned request records the model id the client
// named; an auto request records NULL. This is what lets analytics split
// pinned vs auto traffic and surface failover overrides.
describe('requested_model analytics logging', () => {
  let app: Express;
  let groqModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    // Any enabled groq model from the seeded catalog will do as the pin target.
    groqModelId = (getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 1
    `).get() as { model_id: string }).model_id;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_pinned_model_test',
      label: 'pinned-model',
    });
    expect(addKey.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-pin', object: 'chat.completion', created: 1, model: groqModelId,
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the pinned model id when the client names a model', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT model_id, requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBe(groqModelId);
    expect(row.model_id).toBe(groqModelId); // pin honored
  });

  it.each([['auto'], [undefined]])('logs NULL requested_model for auto routing (model: %s)', async (model) => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      ...(model ? { model } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBeNull();
  });
});
