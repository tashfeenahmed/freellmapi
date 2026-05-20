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

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys/import creates many keys and skips duplicates', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys/import', {
      keys: [
        { platform: 'groq', key: 'gsk_bulk_1', label: 'Bulk 1' },
        { platform: 'google', key: 'AIza_bulk_2', label: 'Bulk 2' },
        { platform: 'groq', key: 'gsk_bulk_1', label: 'Duplicate' },
      ],
    });

    expect(status).toBe(201);
    expect(body.inserted).toBe(2);
    expect(body.skipped).toBe(1);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(2);
  });

  it('POST /api/keys/import replace mode clears existing keys first', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_existing',
    });

    const { status, body } = await request(app, 'POST', '/api/keys/import', {
      mode: 'replace',
      keys: [
        { platform: 'google', key: 'AIza_replacement_1' },
        { platform: 'openrouter', key: 'sk-or-replacement-2' },
      ],
    });

    expect(status).toBe(201);
    expect(body.inserted).toBe(2);
    expect(body.replaced).toBe(1);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(2);
    expect(after.map((key: any) => key.platform).sort()).toEqual(['google', 'openrouter']);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });
});
