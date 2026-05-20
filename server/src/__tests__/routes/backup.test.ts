import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Backup API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.FREEAPI_UNIFIED_API_KEY;
    delete process.env.FREELLM_UNIFIED_API_KEY;
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/backup/export includes decrypted provider keys and fallback config', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_backup_secret',
      label: 'Backup Key',
    });

    const { status, body } = await request(app, 'GET', '/api/backup/export');

    expect(status).toBe(200);
    expect(body.format).toBe('freellmapi-backup');
    expect(body.providerKeys).toHaveLength(1);
    expect(body.providerKeys[0]).toMatchObject({
      platform: 'groq',
      label: 'Backup Key',
      key: 'gsk_backup_secret',
    });
    expect(body.fallback.length).toBeGreaterThan(0);
  });

  it('POST /api/backup/import restores exported provider keys', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'google',
      key: 'AIza_backup_restore',
      label: 'Restore Key',
    });
    const { body: backup } = await request(app, 'GET', '/api/backup/export');

    getDb().prepare('DELETE FROM api_keys').run();
    expect((await request(app, 'GET', '/api/keys')).body).toHaveLength(0);

    const { status, body } = await request(app, 'POST', '/api/backup/import', {
      ...backup,
      mode: 'replace',
      restoreUnifiedApiKey: false,
    });

    expect(status).toBe(201);
    expect(body.keys.inserted).toBe(1);

    const { body: restored } = await request(app, 'GET', '/api/keys');
    expect(restored).toHaveLength(1);
    expect(restored[0].platform).toBe('google');
    expect(restored[0].label).toBe('Restore Key');
  });
});
