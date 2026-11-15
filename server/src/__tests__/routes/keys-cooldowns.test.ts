import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { setCooldown, isOnCooldown } from '../../services/ratelimit.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
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

async function createKey(app: Express, platform: string, key: string) {
  const { body } = await request(app, 'POST', '/api/keys', { platform, key, label: `${platform} key` });
  return body.id as number;
}

describe('Key cooldown visibility and clearing', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('reports an empty cooldown list for a key that is not benched', async () => {
    await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body[0].cooldowns).toEqual([]);
  });

  it('surfaces active cooldowns on the key list', async () => {
    const id = await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    setCooldown('groq', 'llama-3.3-70b', id, 5 * 60_000);

    const { body } = await request(app, 'GET', '/api/keys');
    const key = body.find((k: any) => k.id === id);

    expect(key.cooldowns).toHaveLength(1);
    expect(key.cooldowns[0].modelId).toBe('llama-3.3-70b');
    expect(key.cooldowns[0].remainingMs).toBeGreaterThan(0);
    // The point of the field: status still reads healthy while the router skips it.
    expect(key.status).not.toBe('cooling');
  });

  it('surfaces APINex check-in cooldown provenance without marking the key unhealthy', async () => {
    const id = await createKey(app, 'apinex', 'api-test-key-value123456');
    setCooldown('apinex', 'free/gemini-3.8-flash', id, 15 * 60_000, 'checkin');
    const { status, body } = await request(app, 'GET', '/api/keys');
    const key = body.find((k: any) => k.id === id);
    expect(status).toBe(200);
    expect(key.cooldowns).toEqual([expect.objectContaining({
      modelId: 'free/gemini-3.8-flash', source: 'checkin',
    })]);
  });

  it('APINex check-in recovery removes only check-in holds, not credit or rate limits', async () => {
    const id = await createKey(app, 'apinex', 'api-test-key-value123456');
    const sibling = await createKey(app, 'apinex', 'api-test-key-value654321');
    setCooldown('apinex', 'free/gemini-3.8-flash', id, 15 * 60_000, 'checkin');
    setCooldown('apinex', 'free/qwen3', id, 15 * 60_000, 'checkin');
    setCooldown('apinex', 'free/deepseek', id, 60 * 60_000, 'credit');
    setCooldown('apinex', 'free/llama', id, 60 * 60_000, 'authoritative');
    setCooldown('apinex', 'free/gemini-3.8-flash', sibling, 15 * 60_000, 'checkin');

    const { status, body } = await request(app, 'DELETE', `/api/keys/${id}/cooldowns/checkin`);
    expect(status).toBe(200);
    expect(body.cleared).toBe(2);
    expect(isOnCooldown('apinex', 'free/gemini-3.8-flash', id)).toBe(false);
    expect(isOnCooldown('apinex', 'free/qwen3', id)).toBe(false);
    expect(isOnCooldown('apinex', 'free/deepseek', id)).toBe(true);
    expect(isOnCooldown('apinex', 'free/llama', id)).toBe(true);
    expect(isOnCooldown('apinex', 'free/gemini-3.8-flash', sibling)).toBe(true);

    const after = await request(app, 'GET', '/api/keys');
    const key = after.body.find((k: any) => k.id === id);
    expect(key.cooldowns.map((c: any) => c.source).sort()).toEqual(['authoritative', 'credit']);

    const repeated = await request(app, 'DELETE', `/api/keys/${id}/cooldowns/checkin`);
    expect(repeated.body.cleared).toBe(0);
  });

  it('APINex check-in recovery rejects unrelated providers and unknown keys', async () => {
    const groq = await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    setCooldown('groq', 'llama-3.3-70b', groq, 60 * 60_000, 'credit');
    expect((await request(app, 'DELETE', `/api/keys/${groq}/cooldowns/checkin`)).status).toBe(400);
    expect(isOnCooldown('groq', 'llama-3.3-70b', groq)).toBe(true);
    expect((await request(app, 'DELETE', '/api/keys/987654/cooldowns/checkin')).status).toBe(404);
    expect((await request(app, 'DELETE', '/api/keys/abc/cooldowns/checkin')).status).toBe(400);
  });

  it('DELETE /api/keys/:id/cooldowns clears them and reports the count', async () => {
    const id = await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    setCooldown('groq', 'llama-3.3-70b', id, 60 * 60_000);
    setCooldown('groq', 'llama-3.1-8b', id, 60 * 60_000);

    const { status, body } = await request(app, 'DELETE', `/api/keys/${id}/cooldowns`);
    expect(status).toBe(200);
    expect(body.cleared).toBe(2);

    expect(isOnCooldown('groq', 'llama-3.3-70b', id)).toBe(false);
    const after = await request(app, 'GET', '/api/keys');
    expect(after.body.find((k: any) => k.id === id).cooldowns).toEqual([]);
  });

  it('does not disturb cooldowns belonging to another key', async () => {
    const a = await createKey(app, 'groq', 'gsk_testkeyvalueAAAAAA');
    const b = await createKey(app, 'cerebras', 'csk-testkeyvalueBBBBBB');
    setCooldown('groq', 'llama-3.3-70b', a, 60 * 60_000);
    setCooldown('cerebras', 'qwen-3-coder', b, 60 * 60_000);

    await request(app, 'DELETE', `/api/keys/${a}/cooldowns`);

    expect(isOnCooldown('groq', 'llama-3.3-70b', a)).toBe(false);
    expect(isOnCooldown('cerebras', 'qwen-3-coder', b)).toBe(true);
  });

  it('returns 404 for an unknown key and 400 for a non-numeric id', async () => {
    const missing = await request(app, 'DELETE', '/api/keys/987654/cooldowns');
    expect(missing.status).toBe(404);

    const bad = await request(app, 'DELETE', '/api/keys/abc/cooldowns');
    expect(bad.status).toBe(400);
  });

  it('requires dashboard auth', async () => {
    const id = await createKey(app, 'groq', 'gsk_testkeyvalue123456');
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/${id}/cooldowns`, {
      method: 'DELETE',
    });
    server.close();
    expect(res.status).toBe(401);
  });
});
