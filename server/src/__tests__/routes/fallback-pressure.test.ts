import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { recordRateLimitHit, getAllPenalties } from '../../services/router.js';
import { setCooldown, isOnCooldown, getNextCooldownDuration, getCooldownCeilingMs } from '../../services/ratelimit.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
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

// #952: the Router pressure panel's "Clear all" and the cooldown-ceiling knob.
describe('Router pressure controls (#952)', () => {
  let app: Express;
  let keyId: number;
  let modelDbId: number;
  let platform: string;
  let modelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    const db = getDb();
    const model = db.prepare('SELECT id, platform, model_id FROM models WHERE enabled = 1 LIMIT 1').get() as any;
    modelDbId = model.id; platform = model.platform; modelId = model.model_id;
    const enc = encrypt('test-key-952');
    const info = db.prepare(`
      INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, label, status, enabled)
      VALUES (?, ?, ?, ?, 'pressure-952', 'healthy', 1)
    `).run(platform, enc.encrypted, enc.iv, enc.authTag);
    keyId = Number(info.lastInsertRowid);
  });

  it('DELETE /api/fallback/penalty-inspector lifts cooldowns, penalties and ladder state', async () => {
    // Build pressure: a day-long bench on the key, a penalty on the model, and
    // two ladder steps so the next hit would otherwise be the 1h rung.
    setCooldown(platform, modelId, keyId, 24 * 60 * 60_000, 'heuristic');
    recordRateLimitHit(modelDbId);
    getNextCooldownDuration(platform, modelId, keyId);
    getNextCooldownDuration(platform, modelId, keyId);
    expect(isOnCooldown(platform, modelId, keyId)).toBe(true);
    expect(getAllPenalties().some(p => p.modelDbId === modelDbId)).toBe(true);

    const before = await request(app, 'GET', '/api/fallback/penalty-inspector');
    expect(before.status).toBe(200);
    expect(before.body.rows.length).toBeGreaterThan(0);

    const cleared = await request(app, 'DELETE', '/api/fallback/penalty-inspector');
    expect(cleared.status).toBe(200);
    expect(cleared.body.cooldowns).toBeGreaterThanOrEqual(1);
    expect(cleared.body.penalties).toBeGreaterThanOrEqual(1);
    expect(typeof cleared.body.failureWindows).toBe('number');

    expect(isOnCooldown(platform, modelId, keyId)).toBe(false);
    expect(getAllPenalties().some(p => p.modelDbId === modelDbId)).toBe(false);
    // Ladder restarted: the next hit is the first rung again, not the third.
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * 60_000);

    const after = await request(app, 'GET', '/api/fallback/penalty-inspector');
    expect(after.body.rows.some((r: any) => r.cooldowns.length > 0 || r.penalty.value > 0)).toBe(false);
  });

  it('GET /api/fallback/routing reports the ceiling; PUT sets, echoes and clears it', async () => {
    const initial = await request(app, 'GET', '/api/fallback/routing');
    expect(initial.status).toBe(200);
    expect(initial.body.cooldownCeilingMs).toBeNull();

    const set = await request(app, 'PUT', '/api/fallback/routing', { strategy: initial.body.strategy, cooldownCeilingMs: 3_600_000 });
    expect(set.status).toBe(200);
    expect(set.body.cooldownCeilingMs).toBe(3_600_000);
    expect(getCooldownCeilingMs()).toBe(3_600_000);

    const read = await request(app, 'GET', '/api/fallback/routing');
    expect(read.body.cooldownCeilingMs).toBe(3_600_000);

    // Omitting the field leaves it alone; null clears it.
    const untouched = await request(app, 'PUT', '/api/fallback/routing', { strategy: initial.body.strategy });
    expect(untouched.body.cooldownCeilingMs).toBe(3_600_000);
    const clearedCeiling = await request(app, 'PUT', '/api/fallback/routing', { strategy: initial.body.strategy, cooldownCeilingMs: null });
    expect(clearedCeiling.status).toBe(200);
    expect(clearedCeiling.body.cooldownCeilingMs).toBeNull();
  });

  it('PUT /api/fallback/routing rejects a ceiling outside 1 min .. 24 h', async () => {
    const routing = await request(app, 'GET', '/api/fallback/routing');
    const low = await request(app, 'PUT', '/api/fallback/routing', { strategy: routing.body.strategy, cooldownCeilingMs: 1000 });
    expect(low.status).toBe(400);
    expect(low.body.error.message).toMatch(/at least/);
    const high = await request(app, 'PUT', '/api/fallback/routing', { strategy: routing.body.strategy, cooldownCeilingMs: 48 * 3_600_000 });
    expect(high.status).toBe(400);
    expect(high.body.error.message).toMatch(/at most/);
    expect(getCooldownCeilingMs()).toBeNull();
  });
});
