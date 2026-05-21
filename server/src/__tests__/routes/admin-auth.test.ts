import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, headers?: Record<string, string>) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, { method, headers });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Admin API authentication', () => {
  let app: Express;

  const protectedRoutes = [
    ['GET', '/api/settings/api-key'],
    ['GET', '/api/keys'],
    ['GET', '/api/fallback'],
    ['POST', '/api/health/check-all'],
    ['GET', '/api/analytics/summary'],
  ] as const;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp({ adminAuth: { allowLocalBypass: false } });
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  it.each(protectedRoutes)('%s %s rejects requests without admin auth', async (method, path) => {
    const { status, body } = await request(app, method, path);
    expect(status).toBe(401);
    expect(body.error.message).toBe('Admin authentication required');
  });

  it.each(protectedRoutes)('%s %s accepts the unified bearer token', async (method, path) => {
    const { status } = await request(app, method, path, {
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    });
    expect(status).toBe(200);
  });
});
