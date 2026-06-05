import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function insertRequest(createdAt: string, opts?: { status?: string; error?: string | null; modelId?: string }) {
  const db = getDb();
  const status = opts?.status ?? 'success';
  const error = opts?.error ?? null;
  const modelId = opts?.modelId ?? 'test-model';
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES ('test', ?, ?, 1, 2, 3, ?, ?)
  `).run(modelId, status, error, createdAt);
}

describe('Analytics API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a rolling 24-hour window for summary analytics', async () => {
    insertRequest('2026-05-28 11:59:59');
    insertRequest('2026-05-28 12:00:00');
    insertRequest('2026-05-29 11:59:59');

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');

    expect(status).toBe(200);
    expect(body.totalRequests).toBe(2);
    expect(body.totalInputTokens).toBe(2);
    expect(body.totalOutputTokens).toBe(4);
  });

  it.each([
    ['7d', '2026-05-22 11:59:59', '2026-05-22 12:00:00'],
    ['30d', '2026-04-29 11:59:59', '2026-04-29 12:00:00'],
  ])('uses a rolling %s window for summary analytics', async (range, outside, boundary) => {
    insertRequest(outside);
    insertRequest(boundary);
    insertRequest('2026-05-29 11:59:59');

    const { status, body } = await request(app, `/api/analytics/summary?range=${range}`);

    expect(status).toBe(200);
    expect(body.totalRequests).toBe(2);
  });

  it('returns the last 100 live requests with optional errors-only filter', async () => {
    insertRequest('2026-05-29 10:00:00', { status: 'success', modelId: 'model-a' });
    insertRequest('2026-05-29 10:01:00', { status: 'error', error: '502 Bad Gateway', modelId: 'model-b' });
    insertRequest('2026-05-29 10:02:00', { status: 'error', error: '429 Rate Limit', modelId: 'model-c' });

    const all = await request(app, '/api/analytics/live-requests?range=24h');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(3);
    expect(all.body[0].status).toBe('error');
    expect(all.body[0].displayName).toBe('model-c');

    const errorsOnly = await request(app, '/api/analytics/live-requests?range=24h&errorsOnly=true');
    expect(errorsOnly.status).toBe(200);
    expect(errorsOnly.body).toHaveLength(2);
    expect(errorsOnly.body.every((r: any) => r.status === 'error')).toBe(true);
  });
});
