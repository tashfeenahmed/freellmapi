import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import type { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function post(app: Express, path: string, body: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function del(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'DELETE',
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// AgentRouter tokens are scoped to a user-chosen model set (per the provider's
// own panel); GET /v1/models returns exactly that set. The dashboard discovers
// it, lets the user trim it, then registers the chosen models bound to the key
// — same per-key model binding the custom-endpoint flow uses. We spy the
// provider's listModels (not global.fetch) so the test's own request to the app
// keeps working.
describe('AgentRouter key flow', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('discovers the token\'s models through the provider', async () => {
    const spy = vi.spyOn(getProvider('agentrouter') as OpenAICompatProvider, 'listModels')
      .mockResolvedValue(['glm-5.2', 'gpt-5.5']);
    const { status, body } = await post(app, '/api/keys/agentrouter/discover', { apiKey: 'sk-token' });
    expect(status).toBe(200);
    expect(body.models).toEqual(['glm-5.2', 'gpt-5.5']);
    expect(spy).toHaveBeenCalledWith('sk-token');
    spy.mockRestore();
  });

  it('surfaces a 400 when discovery fails (bad / over-scoped key)', async () => {
    const spy = vi.spyOn(getProvider('agentrouter') as OpenAICompatProvider, 'listModels')
      .mockRejectedValue(new Error('unauthorized client detected'));
    const { status, body } = await post(app, '/api/keys/agentrouter/discover', { apiKey: 'bad' });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/unauthorized client detected/);
    spy.mockRestore();
  });

  it('requires an apiKey to discover', async () => {
    const { status } = await post(app, '/api/keys/agentrouter/discover', {});
    expect(status).toBe(400);
  });

  it('registers the selected models bound to the key, with fallback entries', async () => {
    const { status, body } = await post(app, '/api/keys/agentrouter', {
      apiKey: 'sk-token',
      models: ['glm-5.2', 'gpt-5.5'],
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('agentrouter');
    expect(body.models.map((m: any) => m.model).sort()).toEqual(['glm-5.2', 'gpt-5.5']);

    const db = getDb();
    const key = db.prepare("SELECT * FROM api_keys WHERE platform = 'agentrouter'").get() as any;
    expect(key).toBeDefined();
    const models = db.prepare("SELECT id, model_id, key_id FROM models WHERE platform = 'agentrouter'").all() as any[];
    expect(models.map(m => m.model_id).sort()).toEqual(['glm-5.2', 'gpt-5.5']);
    expect(models.every(m => m.key_id === key.id)).toBe(true);
    for (const m of models) {
      expect(db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(m.id)).toBeDefined();
    }
  });

  it('rejects an add with no models selected', async () => {
    const { status } = await post(app, '/api/keys/agentrouter', { apiKey: 'sk-token' });
    expect(status).toBe(400);
  });

  it('re-submitting keeps one key and REPLACES the model set (removed ids deregister)', async () => {
    const { status } = await post(app, '/api/keys/agentrouter', {
      apiKey: 'sk-token-rotated',
      models: ['glm-5.2', 'claude-opus-4-8'],
    });
    expect(status).toBe(201);

    const db = getDb();
    expect((db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'agentrouter'").get() as any).n).toBe(1);
    const ids = (db.prepare("SELECT model_id FROM models WHERE platform = 'agentrouter'").all() as any[]).map(r => r.model_id).sort();
    expect(ids).toEqual(['claude-opus-4-8', 'glm-5.2']); // gpt-5.5 dropped
    // gpt-5.5's fallback entry is gone too — not orphaned.
    const orphan = db.prepare(
      "SELECT 1 FROM fallback_config f JOIN models m ON m.id = f.model_db_id WHERE m.platform = 'agentrouter' AND m.model_id = 'gpt-5.5'",
    ).get();
    expect(orphan).toBeUndefined();
  });

  it('deleting the AgentRouter key cascades its models out of catalog + chain', async () => {
    const db = getDb();
    const key = db.prepare("SELECT id FROM api_keys WHERE platform = 'agentrouter'").get() as any;
    const builtin = (db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform NOT IN ('agentrouter','custom')").get() as any).n;

    const { status } = await del(app, `/api/keys/${key.id}`);
    expect(status).toBe(200);

    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'agentrouter'").get() as any).n).toBe(0);
    const fc = db.prepare(
      "SELECT COUNT(*) AS n FROM fallback_config f JOIN models m ON m.id = f.model_db_id WHERE m.platform = 'agentrouter'",
    ).get() as any;
    expect(fc.n).toBe(0);
    // Built-in catalog rows are untouched.
    expect((db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform NOT IN ('agentrouter','custom')").get() as any).n).toBe(builtin);
  });
});
