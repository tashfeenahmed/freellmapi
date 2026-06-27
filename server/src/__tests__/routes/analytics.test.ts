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

function insertRequest(createdAt: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES ('test', 'test-model', 'success', 1, 2, 3, NULL, ?)
  `).run(createdAt);
}

function insertTokensRequest(
  platform: string,
  modelId: string,
  status: 'success' | 'error',
  inputTokens: number,
  outputTokens: number,
  createdAt: string,
) {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, 3, NULL, ?)
  `).run(platform, modelId, status, inputTokens, outputTokens, createdAt);
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

  it('prices savings at the served model paid-equivalent rate', async () => {
    // groq/llama-3.3-70b-versatile is mapped at $0.10/M in, $0.32/M out
    // (db/model-pricing.ts): 10M in + 5M out → 1.00 + 1.60 = $2.60
    insertTokensRequest('groq', 'llama-3.3-70b-versatile', 'success', 10_000_000, 5_000_000, '2026-05-29 11:00:00');

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');

    expect(status).toBe(200);
    expect(body.estimatedCostSavings).toBe(2.6);
    // Drives the client's span-based 30-day projection
    expect(body.firstRequestAt).toBe('2026-05-29 11:00:00');
  });

  it('falls back to modest default pricing for unmapped models', async () => {
    // Unknown model → $0.20/M in, $0.80/M out: 10M in + 5M out → 2.00 + 4.00 = $6.00
    insertTokensRequest('custom', 'mystery-model', 'success', 10_000_000, 5_000_000, '2026-05-29 11:00:00');

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');

    expect(status).toBe(200);
    expect(body.estimatedCostSavings).toBe(6);
  });

  it('excludes failed requests from savings', async () => {
    insertTokensRequest('groq', 'llama-3.3-70b-versatile', 'error', 10_000_000, 0, '2026-05-29 11:00:00');

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');

    expect(status).toBe(200);
    expect(body.estimatedCostSavings).toBe(0);
  });

  it('returns per-model estimated cost in the by-model breakdown', async () => {
    insertTokensRequest('groq', 'llama-3.3-70b-versatile', 'success', 10_000_000, 5_000_000, '2026-05-29 11:00:00');

    const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

    expect(status).toBe(200);
    expect(body[0].estimatedCost).toBe(2.6);
  });

  describe('pinned vs auto tracking', () => {
    function insertPinnedRequest(modelId: string, requestedModel: string | null, createdAt: string) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, requested_model, status, input_tokens, output_tokens, latency_ms, error, created_at)
        VALUES ('test', ?, ?, 'success', 1, 2, 3, NULL, ?)
      `).run(modelId, requestedModel, createdAt);
    }

    it('summary splits pinned, honored, and auto requests', async () => {
      insertPinnedRequest('model-a', 'model-a', '2026-05-29 11:00:00'); // pin honored
      insertPinnedRequest('model-b', 'model-a', '2026-05-29 11:01:00'); // pin overridden by failover
      insertPinnedRequest('model-b', null, '2026-05-29 11:02:00');      // auto-routed

      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.totalRequests).toBe(3);
      expect(body.pinnedRequests).toBe(2);
      expect(body.pinHonoredRequests).toBe(1);
    });

    it('by-model counts only requests the model served because it was pinned', async () => {
      insertPinnedRequest('model-a', 'model-a', '2026-05-29 11:00:00'); // pinned + served
      insertPinnedRequest('model-a', null, '2026-05-29 11:01:00');      // auto, same model
      insertPinnedRequest('model-a', 'model-x', '2026-05-29 11:02:00'); // failover landed here

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(status).toBe(200);
      const row = body.find((r: any) => r.modelId === 'model-a');
      expect(row.requests).toBe(3);
      expect(row.pinnedRequests).toBe(1);
    });
  });
});
