import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function get(app: Express, path: string, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  server.close();
  return { status: response.status, body: body as any };
}

describe('GET /api/analytics/by-client', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(async () => {
    const pool = (await import('../../db/index.js')).getPostgresPool();
    await pool.query('DELETE FROM analytics_hourly');
  });

  it('groups request volume and success by detected agent', async () => {
    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});
