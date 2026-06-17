import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

describe('provider key-nudge routes', () => {
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
    db.prepare("DELETE FROM settings WHERE key LIKE 'nudge_%'").run();
  });

  it('GET /api/health exposes raw unconfiguredProviders + nudgeState', async () => {
    const { status, body } = await request(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(Array.isArray(body.unconfiguredProviders)).toBe(true);
    expect(body.unconfiguredProviders.some((p: any) => p.platform === 'groq')).toBe(true);
    expect(body.nudgeState).toEqual({ disabled: false, muted: [], snoozed: [] });
  });
});
