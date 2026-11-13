import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string, withAuth = true) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: withAuth ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function addKey(platform: string) {
  const secret = encrypt(`${platform}-test-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

describe('GET /api/keys/providers — provider checklist (#543)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('requires dashboard auth', async () => {
    const { status } = await request(app, '/api/keys/providers', false);
    expect(status).toBe(401);
  });

  it('lists every registered provider as unconfigured before any key, excluding custom', async () => {
    const { status, body } = await request(app, '/api/keys/providers');
    expect(status).toBe(200);
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.every((p: { configured: boolean }) => p.configured === false)).toBe(true);
    expect(body.providers.some((p: { platform: string }) => p.platform === 'custom')).toBe(false);
    // A well-known free provider is present with the expected shape.
    const groq = body.providers.find((p: { platform: string }) => p.platform === 'groq');
    expect(groq).toMatchObject({ platform: 'groq', configured: false, keyCount: 0 });
    expect(typeof groq.name).toBe('string');
    expect(typeof groq.keyless).toBe('boolean');
    expect(body.providers.find((p: { platform: string }) => p.platform === 'zro'))
      .toMatchObject({ platform: 'zro', name: 'Zro (MoonMath.ai)', configured: false, keyless: false });
    expect(body.providers.find((p: { platform: string }) => p.platform === 'moondream'))
      .toMatchObject({ platform: 'moondream', name: 'Moondream', configured: false, keyless: false });
    expect(body.providers.find((p: { platform: string }) => p.platform === 'llmtr'))
      .toMatchObject({ platform: 'llmtr', name: 'LLMTR', configured: false, keyless: false });
    expect(body.providers.find((p: { platform: string }) => p.platform === 'typhoon'))
      .toMatchObject({ platform: 'typhoon', name: 'Typhoon', configured: false, keyless: false });
    expect(body.providers.find((p: { platform: string }) => p.platform === 'plugsky'))
      .toMatchObject({ platform: 'plugsky', name: 'Plugsky', configured: false, keyless: false });
    for (const [platform, name] of [['gizmo', 'Gizmo'], ['blockrun', 'BlockRun']]) {
      expect(body.providers.find((p: { platform: string }) => p.platform === platform))
        .toMatchObject({ platform, name, configured: false, keyless: false });
    }
    expect(body.summary).toEqual({
      total: body.providers.length,
      configured: 0,
      unconfigured: body.providers.length,
    });
  });

  it('marks a provider configured once it has a key and updates the summary', async () => {
    addKey('groq');
    const { status, body } = await request(app, '/api/keys/providers');
    expect(status).toBe(200);
    const groq = body.providers.find((p: { platform: string }) => p.platform === 'groq');
    expect(groq).toMatchObject({ configured: true, keyCount: 1, enabledKeyCount: 1 });
    expect(body.summary.configured).toBe(1);
    expect(body.summary.unconfigured).toBe(body.summary.total - 1);
  });

  // Unavailable key creation must not remove existing keys or catalog models.
  it.each(['aclide', 'waterfall'])('hides unconfigured %s but preserves configured keys and models (#1768)', async platform => {
    const db = getDb();
    db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES (?, ?, ?, 1, 1, 1)')
      .run(platform, 'existing-test-model', 'Existing model');
    const models = db.prepare('SELECT * FROM models WHERE platform = ?').all(platform);
    let { body } = await request(app, '/api/keys/providers');
    expect(body.providers.some((p: { platform: string }) => p.platform === platform)).toBe(false);
    addKey(platform);
    const savedKey = db.prepare('SELECT * FROM api_keys WHERE platform = ?').get(platform);
    ({ body } = await request(app, '/api/keys/providers'));
    expect(body.providers.find((p: { platform: string }) => p.platform === platform))
      .toMatchObject({ configured: true, keyCount: 1, enabledKeyCount: 1 });
    expect(body.summary.configured).toBe(1);
    expect(db.prepare('SELECT * FROM api_keys WHERE platform = ?').get(platform)).toEqual(savedKey);
    const keys = await request(app, '/api/keys');
    expect(keys.body.find((key: { platform: string }) => key.platform === platform))
      .toMatchObject({ platform, enabled: true, status: 'healthy' });

    // Disabled credentials must remain manageable, not disappear from setup.
    db.prepare('UPDATE api_keys SET enabled = 0 WHERE platform = ?').run(platform);
    ({ body } = await request(app, '/api/keys/providers'));
    expect(body.providers.find((p: { platform: string }) => p.platform === platform))
      .toMatchObject({ configured: true, keyCount: 1, enabledKeyCount: 0 });

    db.prepare('DELETE FROM api_keys WHERE platform = ?').run(platform);
    ({ body } = await request(app, '/api/keys/providers'));
    expect(body.providers.some((p: { platform: string }) => p.platform === platform)).toBe(false);
    expect(db.prepare('SELECT * FROM models WHERE platform = ?').all(platform)).toEqual(models);
  });
});
