import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
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

  it("counts 'canceled' rows in totals but in no success/error rate (#752)", async () => {
    vi.useRealTimers();
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'success', 100, 50, 12, null);
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'error', 30, 0, 9, 'boom');
    logRequest('groq', 'llama-3.3-70b-versatile', 0, 'canceled', 0, 0, 800,
      'client disconnected after 0.8s; upstream request canceled');

    const summary = await request(app, '/api/analytics/summary?range=24h');
    expect(summary.status).toBe(200);
    expect(summary.body.totalRequests).toBe(3); // the canceled request happened
    expect(summary.body.successRate).toBe(50);  // 1 of 2 decided — not 1 of 3

    const byModel = await request(app, '/api/analytics/by-model?range=24h');
    expect(byModel.body[0].requests).toBe(3);
    expect(byModel.body[0].successRate).toBe(50);

    const byPlatform = await request(app, '/api/analytics/by-platform?range=24h');
    expect(byPlatform.body[0].successRate).toBe(50);
    expect(byPlatform.body[0].errorCount).toBe(1); // canceled is not an error
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

  describe('timeline tzOffset', () => {
    it('buckets timeline days by the viewer timezone instead of UTC', async () => {
      insertRequest('2026-05-28 15:30:00'); // UTC day 05-28; UTC+8 23:30, still day 05-28
      insertRequest('2026-05-28 17:30:00'); // UTC day 05-28; UTC+8 01:30 on day 05-29

      const utc = await request(app, '/api/analytics/timeline?range=7d');
      expect(utc.status).toBe(200);
      expect(utc.body.map((b: any) => b.timestamp)).toEqual(['2026-05-28']);

      const local = await request(app, '/api/analytics/timeline?range=7d&tzOffset=480');
      expect(local.status).toBe(200);
      expect(local.body.map((b: any) => b.timestamp)).toEqual(['2026-05-28', '2026-05-29']);
      expect(local.body.map((b: any) => b.requests)).toEqual([1, 1]);
    });

    it('shifts hour labels to the viewer timezone', async () => {
      insertRequest('2026-05-28 17:30:00'); // UTC 17:00 → UTC+8 next-day 01:00

      const { status, body } = await request(app, '/api/analytics/timeline?range=24h&tzOffset=480');
      expect(status).toBe(200);
      expect(body.map((b: any) => b.timestamp)).toEqual(['2026-05-29T01:00:00']);
    });

    it('falls back to UTC bucketing for an invalid tzOffset', async () => {
      insertRequest('2026-05-28 17:30:00');

      for (const bad of ['abc', '9999', '1.5', '480; DROP TABLE request_hourly']) {
        const { status, body } = await request(app, `/api/analytics/timeline?range=7d&tzOffset=${encodeURIComponent(bad)}`);
        expect(status).toBe(200);
        expect(body.map((b: any) => b.timestamp)).toEqual(['2026-05-28']);
      }
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

  // #889 — custom endpoints all share the platform id 'custom', so the
  // provider breakdown must split them by the serving key's base_url (the
  // canonical endpoint identity) instead of collapsing every relay into one
  // "custom" row. These tests seed two distinct custom endpoints (plus a
  // pooled second key on the first) and assert the split, the per-endpoint
  // p95 scoping, and the recent-calls provider filter.
  describe('custom endpoint identifiers (#889)', () => {
    // Seed a custom endpoint key and return its id. base_url is the endpoint
    // identity; the credential itself is a placeholder (never read here).
    function insertCustomKey(id: number, baseUrl: string, label: string): void {
      getDb().prepare(`
        INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, base_url)
        VALUES (?, 'custom', ?, 'x', 'x', 'x', ?)
      `).run(id, label, baseUrl);
    }

    // A model row belonging to ONE endpoint (#651): `models` is unique on
    // (platform, model_id, endpoint_scope), so two relays can each hold their
    // own row for the same model id.
    function insertScopedModel(modelId: string, displayName: string, endpointScope: string): void {
      getDb().prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope)
        VALUES ('custom', ?, ?, 50, 50, ?)
      `).run(modelId, displayName, endpointScope);
    }

    beforeEach(() => {
      getDb().prepare('DELETE FROM api_keys').run();
      // Only endpoint-scoped rows; the seeded catalog ('' scope) stays put.
      getDb().prepare("DELETE FROM models WHERE endpoint_scope <> ''").run();
    });

    it('splits custom endpoints into per-endpoint rows instead of one "custom" row', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');

      // Two requests on relay A, one on relay B.
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 120, createdAt: '2026-05-29 11:01:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 900, createdAt: '2026-05-29 11:02:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      // Two distinct custom rows — NOT a single collapsed "custom" row.
      const customRows = body.filter((r: any) => r.platform === 'custom');
      expect(customRows).toHaveLength(2);

      const a = body.find((r: any) => r.providerId === 'custom:https://relay-a.example.com/v1');
      const b = body.find((r: any) => r.providerId === 'custom:https://relay-b.example.com/v1');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a.requests).toBe(2);
      expect(b.requests).toBe(1);
      // The operator-readable identifier is the endpoint host.
      expect(a.endpoint).toBe('relay-a.example.com');
      expect(b.endpoint).toBe('relay-b.example.com');
      // Each row keeps the raw platform id for the platform-dot coloring.
      expect(a.platform).toBe('custom');
      expect(b.platform).toBe('custom');
    });

    it('groups a pooled endpoint (several keys, one base_url) into a single row', async () => {
      // Two credentials for the SAME relay — the pooling case (#619). They
      // share a base_url, so they must read as ONE endpoint, not two rows.
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A key 1');
      insertCustomKey(2, 'https://relay-a.example.com/v1', 'Relay A key 2');

      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 110, createdAt: '2026-05-29 11:01:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const customRows = body.filter((r: any) => r.platform === 'custom');
      expect(customRows).toHaveLength(1);
      expect(customRows[0].providerId).toBe('custom:https://relay-a.example.com/v1');
      expect(customRows[0].requests).toBe(2);
    });

    it('scopes p95 latency per endpoint, not across all custom traffic', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');

      // Relay A: fast (100ms x10). Relay B: slow (1000ms x10). If p95 bled
      // across the whole "custom" platform, A's p95 would be ~1000, not 100.
      for (let i = 0; i < 10; i++) {
        insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: `2026-05-29 10:${String(i).padStart(2, '0')}:00` });
      }
      for (let i = 0; i < 10; i++) {
        insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 1000, createdAt: `2026-05-29 10:${String(i).padStart(2, '0')}:30` });
      }

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const a = body.find((r: any) => r.providerId === 'custom:https://relay-a.example.com/v1');
      const b = body.find((r: any) => r.providerId === 'custom:https://relay-b.example.com/v1');
      expect(a.p95LatencyMs).toBe(100);
      expect(b.p95LatencyMs).toBe(1000);
    });

    it('keeps catalog providers on their bare platform id (no custom: prefix)', async () => {
      insertRaw({ platform: 'groq', keyId: null, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const groq = body.find((r: any) => r.platform === 'groq');
      expect(groq.providerId).toBe('groq');
      expect(groq.endpoint).toBe('groq');
    });

    it('falls back to the plain "custom" id when the key was deleted', async () => {
      // A custom request whose key no longer exists: base_url is unknown, so
      // the row keeps the pre-fix "custom" shape rather than a fake host.
      insertRaw({ platform: 'custom', keyId: 99, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const row = body.find((r: any) => r.platform === 'custom');
      expect(row.providerId).toBe('custom');
      expect(row.endpoint).toBe('custom');
    });

    it('filters recent calls by a custom endpoint providerId', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');

      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 120, createdAt: '2026-05-29 11:01:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 900, createdAt: '2026-05-29 11:02:00' });

      const a = await request(app, '/api/analytics/requests?range=24h&provider=' + encodeURIComponent('custom:https://relay-a.example.com/v1'));
      expect(a.status).toBe(200);
      expect(a.body.total).toBe(2);
      expect(a.body.rows.every((r: any) => r.keyLabel === 'Relay A')).toBe(true);

      const b = await request(app, '/api/analytics/requests?range=24h&provider=' + encodeURIComponent('custom:https://relay-b.example.com/v1'));
      expect(b.status).toBe(200);
      expect(b.body.total).toBe(1);
      expect(b.body.rows[0].keyLabel).toBe('Relay B');
    });

    it('tells two endpoints on the same host apart', async () => {
      // One gateway, two tenants. Host alone is the same string for both, so a
      // host-only display name would show two identical rows the operator
      // cannot match to an endpoint — the #889 collision one level down.
      insertCustomKey(1, 'https://gw.example.com/tenant-a/v1', 'Tenant A');
      insertCustomKey(2, 'https://gw.example.com/tenant-b/v1', 'Tenant B');

      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 200, createdAt: '2026-05-29 11:01:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const rows = body.filter((r: any) => r.platform === 'custom');
      expect(rows).toHaveLength(2);
      const names = rows.map((r: any) => r.endpoint).sort();
      expect(names).toEqual(['gw.example.com/tenant-a/v1', 'gw.example.com/tenant-b/v1']);
      // Distinct names, one per endpoint — not 'gw.example.com' twice.
      expect(new Set(names).size).toBe(2);
    });

    it('groups an endpoint stored with and without a trailing slash as one row', async () => {
      // keys.ts normalizes base_url on write, but rows written before it did
      // carry the raw string. Same endpoint, so: one row, one id.
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A key 1');
      insertCustomKey(2, 'https://relay-a.example.com/v1/', 'Relay A key 2');

      insertRaw({ platform: 'custom', keyId: 1, status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'success', latencyMs: 110, createdAt: '2026-05-29 11:01:00' });

      const { status, body } = await request(app, '/api/analytics/by-platform?range=24h');
      expect(status).toBe(200);

      const rows = body.filter((r: any) => r.platform === 'custom');
      expect(rows).toHaveLength(1);
      expect(rows[0].providerId).toBe('custom:https://relay-a.example.com/v1');
      expect(rows[0].requests).toBe(2);
    });

    it('names the endpoint behind each recent error', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');

      insertRaw({ platform: 'custom', keyId: 1, status: 'error', error: 'relay A exploded', createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'error', error: 'relay B exploded', createdAt: '2026-05-29 11:01:00' });
      insertRaw({ platform: 'groq', keyId: null, status: 'error', error: 'groq exploded', createdAt: '2026-05-29 11:02:00' });

      const { status, body } = await request(app, '/api/analytics/errors?range=24h');
      expect(status).toBe(200);

      const a = body.find((r: any) => r.error === 'relay A exploded');
      const b = body.find((r: any) => r.error === 'relay B exploded');
      const groq = body.find((r: any) => r.error === 'groq exploded');
      // Each error says WHICH relay failed instead of a bare 'custom'.
      expect(a.providerId).toBe('custom:https://relay-a.example.com/v1');
      expect(a.endpoint).toBe('relay-a.example.com');
      expect(b.providerId).toBe('custom:https://relay-b.example.com/v1');
      expect(b.endpoint).toBe('relay-b.example.com');
      // The platform slug is still there for the client's dot coloring.
      expect(a.platform).toBe('custom');
      // Catalog providers are untouched.
      expect(groq.providerId).toBe('groq');
      expect(groq.endpoint).toBe('groq');
      // An orphaned custom error keeps the pre-fix shape.
      insertRaw({ platform: 'custom', keyId: 99, status: 'error', error: 'orphan exploded', createdAt: '2026-05-29 11:03:00' });
      const again = await request(app, '/api/analytics/errors?range=24h');
      const orphan = again.body.find((r: any) => r.error === 'orphan exploded');
      expect(orphan.providerId).toBe('custom');
      expect(orphan.endpoint).toBe('custom');
    });

    it('splits one model id across the relays that served it', async () => {
      // The same model name behind two relays is two different services with
      // two different latencies; one merged 'custom' row describes neither.
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');
      insertScopedModel('shared-model', 'Shared (A)', 'https://relay-a.example.com/v1');
      insertScopedModel('shared-model', 'Shared (B)', 'https://relay-b.example.com/v1');

      insertRaw({ platform: 'custom', keyId: 1, modelId: 'shared-model', status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 1, modelId: 'shared-model', status: 'success', latencyMs: 100, createdAt: '2026-05-29 11:01:00' });
      insertRaw({ platform: 'custom', keyId: 2, modelId: 'shared-model', status: 'success', latencyMs: 900, createdAt: '2026-05-29 11:02:00' });

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');
      expect(status).toBe(200);

      const rows = body.filter((r: any) => r.modelId === 'shared-model');
      expect(rows).toHaveLength(2);

      const a = rows.find((r: any) => r.providerId === 'custom:https://relay-a.example.com/v1');
      const b = rows.find((r: any) => r.providerId === 'custom:https://relay-b.example.com/v1');
      expect(a.requests).toBe(2);
      expect(b.requests).toBe(1);
      // Counts are per endpoint, not the fan-out of one endpoint's requests
      // across every models row that shares the id.
      expect(a.requests + b.requests).toBe(3);
      expect(a.endpoint).toBe('relay-a.example.com');
      expect(b.endpoint).toBe('relay-b.example.com');
      // Each row's latency is its own endpoint's, not the pooled average.
      expect(a.avgLatencyMs).toBe(100);
      expect(b.avgLatencyMs).toBe(900);
      // The display name comes from the model row of the serving endpoint.
      expect(a.displayName).toBe('Shared (A)');
      expect(b.displayName).toBe('Shared (B)');
    });

    it('keeps catalog models on one row per platform in by-model', async () => {
      insertRaw({ platform: 'groq', keyId: null, modelId: 'llama-3.1-8b-instant', status: 'success', latencyMs: 50, createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'groq', keyId: null, modelId: 'llama-3.1-8b-instant', status: 'success', latencyMs: 70, createdAt: '2026-05-29 11:01:00' });

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');
      expect(status).toBe(200);

      const rows = body.filter((r: any) => r.platform === 'groq');
      expect(rows).toHaveLength(1);
      expect(rows[0].requests).toBe(2);
      expect(rows[0].providerId).toBe('groq');
      expect(rows[0].endpoint).toBe('groq');
    });

    it('splits the error distribution per custom endpoint', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertCustomKey(2, 'https://relay-b.example.com/v1', 'Relay B');

      insertRaw({ platform: 'custom', keyId: 1, status: 'error', error: '429 rate limit', createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 1, status: 'error', error: '429 rate limit', createdAt: '2026-05-29 11:01:00' });
      insertRaw({ platform: 'custom', keyId: 2, status: 'error', error: 'timeout', createdAt: '2026-05-29 11:02:00' });
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', createdAt: '2026-05-29 11:03:00' });

      const { status, body } = await request(app, '/api/analytics/error-distribution?range=24h');
      expect(status).toBe(200);

      const custom = body.byPlatform.filter((r: any) => r.platform === 'custom');
      // Two bars, one per relay — not one 'custom' bar of 3 that names no
      // endpoint the operator could go and fix.
      expect(custom).toHaveLength(2);
      const a = custom.find((r: any) => r.providerId === 'custom:https://relay-a.example.com/v1');
      const b = custom.find((r: any) => r.providerId === 'custom:https://relay-b.example.com/v1');
      expect(a.count).toBe(2);
      expect(a.endpoint).toBe('relay-a.example.com');
      expect(b.count).toBe(1);
      expect(b.endpoint).toBe('relay-b.example.com');
      // Category totals are endpoint-agnostic and must not change shape.
      expect(body.byCategory.find((c: any) => c.category === 'Rate Limited (429)').count).toBe(2);
    });

    it('filters recent calls by the bare "custom" id to the orphaned rows only', async () => {
      // The bare id is what /by-platform emits for rows whose endpoint is
      // unknown. Selecting it must return exactly the rows that row counted —
      // not every relay's traffic, which would contradict the count clicked.
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');

      insertRaw({ platform: 'custom', keyId: 1, status: 'success', createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', createdAt: '2026-05-29 11:01:00' });
      // Key deleted after the fact (dangling id) and a row that never had one.
      insertRaw({ platform: 'custom', keyId: 99, status: 'success', createdAt: '2026-05-29 11:02:00' });
      insertRaw({ platform: 'custom', keyId: null, status: 'success', createdAt: '2026-05-29 11:03:00' });

      const platforms = await request(app, '/api/analytics/by-platform?range=24h');
      const orphanRow = platforms.body.find((r: any) => r.providerId === 'custom');
      expect(orphanRow.requests).toBe(2);

      const filtered = await request(app, '/api/analytics/requests?range=24h&provider=custom');
      expect(filtered.status).toBe(200);
      // The list agrees with the row: 2, not all 4 custom requests.
      expect(filtered.body.total).toBe(orphanRow.requests);
      expect(filtered.body.rows.every((r: any) => r.keyLabel === null)).toBe(true);

      // The named endpoint still filters to itself...
      const relayA = await request(app, '/api/analytics/requests?range=24h&provider=' + encodeURIComponent('custom:https://relay-a.example.com/v1'));
      expect(relayA.body.total).toBe(2);
      // ...and the legacy platform param keeps its pre-#889 meaning: all of it.
      const legacy = await request(app, '/api/analytics/requests?range=24h&platform=custom');
      expect(legacy.body.total).toBe(4);
    });

    it('still accepts the legacy platform filter and rejects malformed provider ids', async () => {
      insertCustomKey(1, 'https://relay-a.example.com/v1', 'Relay A');
      insertRaw({ platform: 'custom', keyId: 1, status: 'success', createdAt: '2026-05-29 11:00:00' });
      insertRaw({ platform: 'groq', keyId: null, status: 'success', createdAt: '2026-05-29 11:01:00' });

      // Legacy platform filter still works.
      const legacy = await request(app, '/api/analytics/requests?range=24h&platform=groq');
      expect(legacy.status).toBe(200);
      expect(legacy.body.total).toBe(1);

      // A 'custom:' id carries an arbitrary base_url, but it is applied as a
      // BOUND parameter (never interpolated), so a hostile-looking value is
      // safe — it simply matches nothing.
      const customNoMatch = await request(app, '/api/analytics/requests?range=24h&provider=' + encodeURIComponent('custom:https://relay-a.example.com/v1; DROP TABLE requests'));
      expect(customNoMatch.status).toBe(200);
      expect(customNoMatch.body.total).toBe(0);

      // Non-custom ids must be short slugs; anything else is a client bug.
      for (const bad of ['has spaces', 'a\nb']) {
        const res = await request(app, '/api/analytics/requests?range=24h&provider=' + encodeURIComponent(bad));
        expect(res.status).toBe(400);
      }
    });
  });
});
