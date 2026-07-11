import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
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
  upsertAggregate(db, createdAt, 'success', 1, 2);
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
  upsertAggregate(db, createdAt, status, inputTokens, outputTokens);
}

// Mirror the production aggregates written by lib/request-log.logRequest so the
// summary endpoint (which now reads from request_hourly + settings) stays
// faithful to what real traffic produces.
function upsertAggregate(
  db: ReturnType<typeof getDb>,
  createdAt: string,
  status: 'success' | 'error',
  inputTokens: number,
  outputTokens: number,
) {
  // Mirror logRequest.hourKey() exactly: created_at truncated to the hour in
  // SQLite's canonical 'YYYY-MM-DD HH:00:00' text (space separator). Using a 'T'
  // here would diverge from production and mask a writer/reader format mismatch.
  const hour = createdAt.slice(0, 13) + ':00:00';
  const isSuccess = status === 'success' ? 1 : 0;
  const isError = status === 'error' ? 1 : 0;
  db.prepare(`
    INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
    VALUES (?, 1, ?, ?, ?, ?)
    ON CONFLICT(hour) DO UPDATE SET
      total_requests = total_requests + 1,
      success_count  = success_count + ?,
      error_count    = error_count + ?,
      input_tokens   = input_tokens + ?,
      output_tokens  = output_tokens + ?
  `).run(hour, isSuccess, isError, inputTokens, outputTokens, isSuccess, isError, inputTokens, outputTokens);

  const incr = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)
  `);
  incr.run('total_requests', '1', 1);
  incr.run('total_input_tokens', String(inputTokens), inputTokens);
  incr.run('total_output_tokens', String(outputTokens), outputTokens);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('first_request_at', ?)
    ON CONFLICT(key) DO NOTHING`).run(createdAt);
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
    getDb().prepare('DELETE FROM request_hourly').run();
    getDb().prepare(`DELETE FROM settings WHERE key IN ('total_requests','total_input_tokens','total_output_tokens','first_request_at')`).run();
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

  // Regression guard for the hour-key FORMAT written by the real production
  // writer (lib/request-log.logRequest). The bug this prevents: the writer
  // stores keys as SQLite's 'YYYY-MM-DD HH:00:00' (space), but the summary
  // reader compared against a '...T...' cutoff, so every bucket on the window's
  // boundary day was silently dropped. The other summary tests seed via the
  // local upsertAggregate() helper; this one pins the writer's actual output so
  // the two can't drift apart unnoticed. Real timers so SQLite's datetime('now')
  // and getSinceTimestamp() agree on "now".
  it('logRequest writes space-format hour keys and they round-trip through summary', async () => {
    vi.useRealTimers();
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'success', 100, 50, 12, null);
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'success', 200, 70, 15, null);
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'error', 30, 0, 9, 'boom');

    // Tight, clock-independent guard: the stored key must match SQLite's
    // created_at text shape (space separator), never a 'T'. A 'T' here is the
    // exact desync that made the summary undercount the boundary day.
    const hours = getDb()
      .prepare('SELECT hour FROM request_hourly')
      .all() as Array<{ hour: string }>;
    expect(hours.length).toBeGreaterThanOrEqual(1); // normally 1 bucket; >1 only if the run straddled an hour tick
    for (const { hour } of hours) {
      expect(hour).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
      expect(hour).not.toContain('T');
    }

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');
    expect(status).toBe(200);
    expect(body.totalRequests).toBe(3);
    expect(body.totalInputTokens).toBe(330);
    expect(body.totalOutputTokens).toBe(120);
    expect(body.successRate).toBe(66.7);
    // Lifetime counter is window-independent; sourced from settings, not buckets.
    expect(body.lifetimeTotalRequests).toBe(3);
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
      upsertAggregate(getDb(), createdAt, 'success', 1, 2);
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

  // Raw-row insert covering the newer columns (ttfb_ms, request_type, key_id,
  // per-row latency). These feed the latency-percentile, TTFT, per-type, and
  // per-key analytics that only exist on the raw table. No aggregate upsert:
  // these tests assert the raw-scoped fields, not the hourly totals.
  function insertRaw(opts: {
    platform?: string;
    modelId?: string;
    keyId?: number | null;
    status?: 'success' | 'error';
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    ttfbMs?: number | null;
    requestType?: string;
    error?: string | null;
    createdAt: string;
  }) {
    const {
      platform = 'test',
      modelId = 'test-model',
      keyId = null,
      status = 'success',
      inputTokens = 0,
      outputTokens = 0,
      latencyMs = 0,
      ttfbMs = null,
      requestType = 'chat',
      error = null,
      createdAt,
    } = opts;
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, request_type, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, ttfbMs, requestType, error, createdAt);
  }

  describe('extended summary fields', () => {
    it('returns latency percentiles from the raw rows', async () => {
      // Latencies 10..100 in a 24h window → p50 = 50, p95 = 90 (nearest-rank),
      // avg = 55.
      for (let ms = 10; ms <= 100; ms += 10) {
        insertRaw({ latencyMs: ms, createdAt: '2026-05-29 11:00:00' });
      }

      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.p50LatencyMs).toBe(50);
      expect(body.p95LatencyMs).toBe(90);
      expect(body.avgLatencyMs).toBe(55);
    });

    it('returns null percentiles and TTFT when the raw window is empty', async () => {
      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.p50LatencyMs).toBeNull();
      expect(body.p95LatencyMs).toBeNull();
      expect(body.avgTtfbMs).toBeNull();
    });

    it('averages TTFT over rows that recorded it and ignores NULL ttfb', async () => {
      insertRaw({ ttfbMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ ttfbMs: 200, createdAt: '2026-05-29 11:01:00' });
      insertRaw({ ttfbMs: null, createdAt: '2026-05-29 11:02:00' });

      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.avgTtfbMs).toBe(150);
    });

    it('splits requests into chat and embedding counts', async () => {
      insertRaw({ requestType: 'chat', createdAt: '2026-05-29 11:00:00' });
      insertRaw({ requestType: 'chat', createdAt: '2026-05-29 11:01:00' });
      insertRaw({ requestType: 'embedding', createdAt: '2026-05-29 11:02:00' });

      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.requestTypeCounts).toEqual({ chat: 2, embedding: 1 });
    });
  });

  describe('extended by-platform fields', () => {
    it('adds p95 latency, avg TTFT, error count, and tokens/sec per platform', async () => {
      // groq: 1 success (100ms, ttfb 20, 1000 out tok) + 1 error (300ms, ttfb 40).
      insertRaw({ platform: 'groq', status: 'success', outputTokens: 1000, latencyMs: 100, ttfbMs: 20, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'groq', status: 'error', outputTokens: 0, latencyMs: 300, ttfbMs: 40, error: 'boom', createdAt: '2026-05-29 11:01:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');

      expect(status).toBe(200);
      const groq = body.find((r: any) => r.platform === 'groq');
      expect(groq.errorCount).toBe(1);
      expect(groq.avgTtfbMs).toBe(30);
      // Only the success row qualifies (output>0 & latency>0): 1000 / 0.1 = 10000 tok/s.
      expect(groq.avgTokensPerSecond).toBe(10000);
      expect(typeof groq.p95LatencyMs).toBe('number');
    });

    it('reports null TTFT and tokens/sec when no rows qualify', async () => {
      insertRaw({ platform: 'nokey', status: 'success', outputTokens: 0, latencyMs: 0, ttfbMs: null, createdAt: '2026-05-29 11:00:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');

      expect(status).toBe(200);
      const row = body.find((r: any) => r.platform === 'nokey');
      expect(row.avgTtfbMs).toBeNull();
      expect(row.avgTokensPerSecond).toBeNull();
    });
  });

  describe('by-key endpoint', () => {
    it('groups usage per key, joins the label, and keeps deleted keys', async () => {
      getDb().prepare('DELETE FROM api_keys').run();
      getDb().prepare(`
        INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag)
        VALUES (1, 'groq', 'Prod key', 'x', 'x', 'x')
      `).run();

      // key 1 (exists): 3 rows, 2 success + 1 error, latency 100/200/300.
      insertRaw({ keyId: 1, status: 'success', inputTokens: 10, outputTokens: 5, latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ keyId: 1, status: 'success', inputTokens: 20, outputTokens: 7, latencyMs: 200, createdAt: '2026-05-29 11:01:00' });
      insertRaw({ keyId: 1, status: 'error', inputTokens: 0, outputTokens: 0, latencyMs: 300, error: 'boom', createdAt: '2026-05-29 11:02:00' });
      // key 99 (deleted — no api_keys row): 2 rows.
      insertRaw({ keyId: 99, status: 'success', latencyMs: 50, createdAt: '2026-05-29 11:03:00' });
      insertRaw({ keyId: 99, status: 'success', latencyMs: 50, createdAt: '2026-05-29 11:04:00' });
      // key_id NULL row must be excluded entirely.
      insertRaw({ keyId: null, status: 'success', createdAt: '2026-05-29 11:05:00' });

      const { status, body } = await request(app, '/api/analytics/by-key?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(2);

      const k1 = body.find((r: any) => r.keyId === 1);
      expect(k1.label).toBe('Prod key');
      expect(k1.platform).toBe('groq');
      expect(k1.requests).toBe(3);
      expect(k1.successRate).toBe(66.7);
      expect(k1.avgLatencyMs).toBe(200);
      expect(k1.totalInputTokens).toBe(30);
      expect(k1.totalOutputTokens).toBe(12);

      const k99 = body.find((r: any) => r.keyId === 99);
      expect(k99.label).toBeNull();
      expect(k99.platform).toBeNull();
      expect(k99.requests).toBe(2);
    });
  });

  describe('90d range', () => {
    it('accepts range=90d across the analytics endpoints', async () => {
      insertRequest('2026-02-01 12:00:00'); // ~117 days ago — outside 90d
      insertRequest('2026-03-15 12:00:00'); // ~75 days ago — inside 90d
      insertRequest('2026-05-29 11:00:00'); // today — inside 90d

      const summary = await request(app, '/api/analytics/summary?range=90d');
      expect(summary.status).toBe(200);
      expect(summary.body.totalRequests).toBe(2);

      const timeline = await request(app, '/api/analytics/timeline?range=90d');
      expect(timeline.status).toBe(200);
      // Day-bucketed for 90d; the two in-window rows land on two days.
      expect(Array.isArray(timeline.body)).toBe(true);
      expect(timeline.body.every((b: any) => 'inputTokens' in b && 'outputTokens' in b)).toBe(true);

      const byPlatform = await request(app, '/api/analytics/by-platform?range=90d');
      expect(byPlatform.status).toBe(200);

      const byKey = await request(app, '/api/analytics/by-key?range=90d');
      expect(byKey.status).toBe(200);
    });
  });
});
