import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import {
  RING_CAPACITY,
  clearLogs,
  currentMaxId,
  initServerLogs,
  providerLog,
  recordLogEntry,
  resetServerLogsForTest,
  ringSnapshot,
} from '../../lib/server-logs.js';
import { installLogRedaction } from '../../lib/log-redaction.js';
import { getServerLogRetentionConfig, pruneServerLogs } from '../../services/request-retention.js';

// The dashboard's server-log viewer: capture, storage, the query surface and
// the auth gate. Same in-memory DB + minted dashboard session as the other
// admin route suites.

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; key?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const token = opts.key ?? opts.token;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

/** A 32-char token built at runtime, never as a literal — a source file holding
 *  one is indistinguishable from a real leak to push protection (see the note
 *  in lib/log-redaction.test.ts). The stride keeps it high-entropy-looking. */
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function filler(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[(i * 7 + 3) % ALNUM.length];
  return out;
}

interface LogsResponse {
  entries: Array<Record<string, unknown>>;
  nextId: number;
  counts: { debug: number; info: number; warn: number; error: number };
}

describe('server log viewer', () => {
  let app: Express;
  let dashToken: string;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
    dashToken = mintDashboardToken('logs@example.com');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM server_logs').run();
    resetServerLogsForTest();
    initServerLogs();
  });

  async function fetchLogs(query = ''): Promise<{ status: number; body: LogsResponse }> {
    const res = await request(app, 'GET', `/api/logs${query}`, { token: dashToken });
    return res as { status: number; body: LogsResponse };
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  describe('capture through the redaction wrapper', () => {
    let restore: (() => void) | null = null;

    afterEach(() => {
      restore?.();
      restore = null;
    });

    it('records console output redacted, at the mapped level', () => {
      const seen: unknown[][] = [];
      const origError = console.error;
      const origLog = console.log;
      const origDebug = console.debug;
      console.error = (...args: unknown[]) => { seen.push(args); };
      console.log = (...args: unknown[]) => { seen.push(args); };
      console.debug = (...args: unknown[]) => { seen.push(args); };

      restore = installLogRedaction();
      const secret = filler(48);
      console.error(`upstream rejected Authorization: Bearer ${secret}`);
      console.log('[Router] routed groq/llama-3.3-70b in 412ms');
      console.debug('cache lookup miss');

      restore();
      console.error = origError;
      console.log = origLog;
      console.debug = origDebug;
      restore = null;

      const entries = ringSnapshot();
      expect(entries).toHaveLength(3);

      // The credential must be gone from the buffer, not merely from stdout.
      expect(entries[0]!.level).toBe('error');
      expect(entries[0]!.message).not.toContain(secret);
      expect(entries[0]!.message).toContain('Bearer [redacted]');

      // console.log is the informational writer; debug keeps its own level.
      expect(entries[1]!.level).toBe('info');
      expect(entries[1]!.source).toBe('Router');
      expect(entries[2]!.level).toBe('debug');
    });

    it('drops the viewer\'s own polling lines at ingest', () => {
      const origLog = console.log;
      console.log = () => undefined;
      restore = installLogRedaction();

      console.log('GET /api/logs?sinceId=12 200 3ms');
      console.log('GET /api/ping 200 1ms');
      console.log('GET /api/models 200 8ms');

      restore();
      console.log = origLog;
      restore = null;

      const messages = ringSnapshot().map(e => e.message);
      expect(messages).toEqual(['GET /api/models 200 8ms']);
    });

    it('caps a very long line instead of dropping it', () => {
      recordLogEntry({ level: 'info', message: 'x'.repeat(20_000) });
      const entry = ringSnapshot().at(-1)!;
      expect(entry.message.length).toBeLessThanOrEqual(6000);
      expect(entry.message.endsWith('[truncated]')).toBe(true);
    });
  });

  // ── Structured events ──────────────────────────────────────────────────────

  it('providerLog round-trips its metadata and mirrors to stdout exactly once', () => {
    const seen: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { seen.push(args); };
    const restore = installLogRedaction();

    providerLog('warn', '[Health] Key 7 (groq) invalid: unauthorized', {
      provider: 'groq',
      model: 'llama-3.3-70b',
      event: 'key_invalid',
      requestId: 'req-42',
    });

    restore();
    console.warn = origWarn;

    // Mirrored — the operator watching the terminal still sees it...
    expect(seen).toHaveLength(1);
    expect(String(seen[0]![0])).toContain('[Health] Key 7');

    // ...and stored exactly once, despite the mirror going through the wrapped
    // console that taps back into the store.
    const entries = ringSnapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'warn',
      provider: 'groq',
      model: 'llama-3.3-70b',
      event: 'key_invalid',
      requestId: 'req-42',
      source: 'Health',
    });
  });

  it('redacts a providerLog message even though it bypasses the console wrapper', () => {
    const secret = filler(40);
    providerLog('error', `[Health] key rejected: sk-${secret}`, { provider: 'openrouter' });
    expect(ringSnapshot().at(-1)!.message).not.toContain(secret);
  });

  // ── Storage ────────────────────────────────────────────────────────────────

  it('persists warn and error only, and preloads them on a cold start', () => {
    recordLogEntry({ level: 'info', message: 'routine' });
    recordLogEntry({ level: 'warn', message: '[Health] key benched', provider: 'groq' });
    recordLogEntry({ level: 'error', message: '[Router] no key available', provider: 'cerebras' });
    recordLogEntry({ level: 'debug', message: 'cache probe' });

    const rows = getDb()
      .prepare('SELECT level, provider, message FROM server_logs ORDER BY id')
      .all() as Array<{ level: string; provider: string | null; message: string }>;
    expect(rows.map(r => r.level)).toEqual(['warn', 'error']);
    expect(rows[0]!.provider).toBe('groq');

    // Cold start: the ring is empty in memory but the durable rows come back.
    resetServerLogsForTest();
    initServerLogs();
    const reloaded = ringSnapshot();
    expect(reloaded.map(e => e.message)).toEqual([
      '[Health] key benched',
      '[Router] no key available',
    ]);
    expect(reloaded.map(e => e.level)).toEqual(['warn', 'error']);
  });

  it('keeps ids strictly increasing across a simulated restart', () => {
    recordLogEntry({ level: 'warn', message: 'before the restart' });
    const beforeMax = currentMaxId();
    expect(beforeMax).toBeGreaterThan(0);

    resetServerLogsForTest();
    initServerLogs();
    // Seeded from MAX(id), so nothing is handed out twice.
    expect(currentMaxId()).toBe(beforeMax);

    const next = recordLogEntry({ level: 'info', message: 'after the restart' })!;
    expect(next.id).toBe(beforeMax + 1);
    expect(ringSnapshot().map(e => e.id)).toEqual([beforeMax, beforeMax + 1]);
  });

  it('bounds the ring at its capacity while ids keep climbing', () => {
    for (let i = 0; i < RING_CAPACITY + 25; i++) {
      recordLogEntry({ level: 'info', message: `line ${i}` });
    }
    const entries = ringSnapshot();
    expect(entries).toHaveLength(RING_CAPACITY);
    expect(entries[0]!.message).toBe('line 25');
    expect(currentMaxId()).toBe(RING_CAPACITY + 25);
  });

  // ── API ────────────────────────────────────────────────────────────────────

  describe('GET /api/logs', () => {
    beforeEach(() => {
      recordLogEntry({ level: 'debug', message: 'cache probe', provider: 'groq' });
      recordLogEntry({ level: 'info', message: '[Router] routed to cerebras', provider: 'cerebras' });
      recordLogEntry({ level: 'warn', message: '[Health] key benched', provider: 'groq', event: 'key_invalid' });
      recordLogEntry({ level: 'error', message: '[Router] all keys exhausted', provider: 'groq' });
    });

    it('returns entries oldest→newest with an ISO ms timestamp and level counts', async () => {
      const { status, body } = await fetchLogs();
      expect(status).toBe(200);
      expect(body.entries.map(e => e.message)).toEqual([
        'cache probe',
        '[Router] routed to cerebras',
        '[Health] key benched',
        '[Router] all keys exhausted',
      ]);
      expect(body.entries[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(body.nextId).toBe(currentMaxId());
      expect(body.counts).toEqual({ debug: 1, info: 1, warn: 1, error: 1 });
      // Absent metadata is omitted rather than sent as null.
      expect(body.entries[0]).not.toHaveProperty('model');
    });

    it('filters by level', async () => {
      const { body } = await fetchLogs('?levels=warn,error');
      expect(body.entries.map(e => e.level)).toEqual(['warn', 'error']);
      // counts stay unfiltered so the level badges do not change as you filter.
      expect(body.counts).toEqual({ debug: 1, info: 1, warn: 1, error: 1 });
    });

    it('rejects an unknown level with 400', async () => {
      const { status, body } = await fetchLogs('?levels=warn,shout');
      expect(status).toBe(400);
      expect(String((body as any).error.message)).toContain('shout');
    });

    it('searches message, provider, source and event case-insensitively', async () => {
      expect((await fetchLogs('?q=EXHAUSTED')).body.entries).toHaveLength(1);
      // matched via provider…
      expect((await fetchLogs('?q=cerebras')).body.entries).toHaveLength(1);
      // …via source…
      expect((await fetchLogs('?q=health')).body.entries).toHaveLength(1);
      // …and via event.
      expect((await fetchLogs('?q=key_invalid')).body.entries).toHaveLength(1);
    });

    it('filters by exact provider', async () => {
      const { body } = await fetchLogs('?provider=groq');
      expect(body.entries).toHaveLength(3);
      expect((await fetchLogs('?provider=gro')).body.entries).toHaveLength(0);
    });

    it('returns only entries newer than sinceId', async () => {
      const first = await fetchLogs();
      const cursor = first.body.nextId;

      recordLogEntry({ level: 'info', message: 'brand new' });
      const second = await fetchLogs(`?sinceId=${cursor}`);
      expect(second.body.entries.map(e => e.message)).toEqual(['brand new']);
      expect(second.body.nextId).toBe(cursor + 1);
    });

    it('returns nothing cheaply when the caller is already caught up', async () => {
      const { body } = await fetchLogs(`?sinceId=${currentMaxId()}`);
      expect(body.entries).toEqual([]);
      // The cursor still advances-in-place and the badges still render.
      expect(body.nextId).toBe(currentMaxId());
      expect(body.counts.error).toBe(1);
    });

    it('advances nextId past entries the filter removed', async () => {
      const before = currentMaxId();
      recordLogEntry({ level: 'info', message: 'noise nobody asked for' });
      const { body } = await fetchLogs(`?levels=error&sinceId=${before}`);
      expect(body.entries).toEqual([]);
      expect(body.nextId).toBe(before + 1);
    });

    it('rejects a malformed sinceId', async () => {
      expect((await fetchLogs('?sinceId=abc')).status).toBe(400);
      expect((await fetchLogs('?sinceId=-1')).status).toBe(400);
      expect((await fetchLogs('?sinceId=1.5')).status).toBe(400);
    });

    it('returns the newest N for a limit, clamped to 1..500', async () => {
      const { body } = await fetchLogs('?limit=2');
      expect(body.entries.map(e => e.message)).toEqual([
        '[Health] key benched',
        '[Router] all keys exhausted',
      ]);

      for (let i = 0; i < 600; i++) recordLogEntry({ level: 'info', message: `bulk ${i}` });
      expect((await fetchLogs('?limit=9999')).body.entries).toHaveLength(500);
      expect((await fetchLogs('?limit=0')).body.entries).toHaveLength(1);
      // A non-numeric limit falls back to the default rather than 400ing.
      expect((await fetchLogs('?limit=lots')).body.entries).toHaveLength(200);
    });
  });

  it('POST /api/logs/clear empties both tiers without rewinding the cursor', async () => {
    recordLogEntry({ level: 'error', message: '[Router] boom' });
    const maxBefore = currentMaxId();

    const res = await request(app, 'POST', '/api/logs/clear', { token: dashToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(ringSnapshot()).toEqual([]);
    const remaining = getDb().prepare('SELECT COUNT(*) AS n FROM server_logs').get() as { n: number };
    expect(remaining.n).toBe(0);
    // Ids must not be reused: an open tab is still holding the old cursor.
    expect(currentMaxId()).toBe(maxBefore);
  });

  // ── Auth ───────────────────────────────────────────────────────────────────

  it('requires a dashboard session, and the unified /v1 key does not open it', async () => {
    for (const path of ['/api/logs', '/api/logs/clear']) {
      const method = path.endsWith('clear') ? 'POST' : 'GET';
      expect((await request(app, method, path)).status).toBe(401);
      expect((await request(app, method, path, { key: unifiedKey })).status).toBe(401);
    }
    expect((await request(app, 'GET', '/api/logs', { token: dashToken })).status).toBe(200);
  });

  // ── Retention ──────────────────────────────────────────────────────────────

  describe('retention', () => {
    const ORIGINAL_DAYS = process.env.SERVER_LOGS_RETENTION_DAYS;
    const ORIGINAL_ROWS = process.env.SERVER_LOGS_MAX_ROWS;

    afterEach(() => {
      if (ORIGINAL_DAYS === undefined) delete process.env.SERVER_LOGS_RETENTION_DAYS;
      else process.env.SERVER_LOGS_RETENTION_DAYS = ORIGINAL_DAYS;
      if (ORIGINAL_ROWS === undefined) delete process.env.SERVER_LOGS_MAX_ROWS;
      else process.env.SERVER_LOGS_MAX_ROWS = ORIGINAL_ROWS;
    });

    function seedRow(id: number, ageMs: number, now: number): void {
      getDb().prepare(`
        INSERT INTO server_logs (id, level, message, created_at_ms)
        VALUES (?, 'warn', ?, ?)
      `).run(id, `row ${id}`, now - ageMs);
    }

    function rowIds(): number[] {
      return (getDb().prepare('SELECT id FROM server_logs ORDER BY id').all() as { id: number }[])
        .map(r => r.id);
    }

    it('defaults to 7 days and 50k rows', () => {
      expect(getServerLogRetentionConfig()).toEqual({ retentionDays: 7, maxRows: 50_000 });
    });

    it('deletes rows past the retention window', () => {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      seedRow(1, 9 * day, now);
      seedRow(2, 8 * day, now);
      seedRow(3, 1 * day, now);

      process.env.SERVER_LOGS_RETENTION_DAYS = '7';
      process.env.SERVER_LOGS_MAX_ROWS = '0';
      expect(pruneServerLogs(getDb(), now)).toBe(2);
      expect(rowIds()).toEqual([3]);
    });

    it('trims the oldest rows past the row ceiling', () => {
      const now = Date.now();
      for (let i = 1; i <= 5; i++) seedRow(i, (5 - i) * 1000, now);

      process.env.SERVER_LOGS_RETENTION_DAYS = '0';
      process.env.SERVER_LOGS_MAX_ROWS = '2';
      expect(pruneServerLogs(getDb(), now)).toBe(3);
      expect(rowIds()).toEqual([4, 5]);
    });

    it('treats 0 as "no limit" on both knobs', () => {
      const now = Date.now();
      seedRow(1, 400 * 24 * 60 * 60 * 1000, now);

      process.env.SERVER_LOGS_RETENTION_DAYS = '0';
      process.env.SERVER_LOGS_MAX_ROWS = '0';
      expect(pruneServerLogs(getDb(), now)).toBe(0);
      expect(rowIds()).toEqual([1]);
    });

    it('is a no-op when the table has not been migrated in', () => {
      const bare = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) };
      expect(pruneServerLogs(bare as any, Date.now())).toBe(0);
    });
  });

  it('clearLogs is safe with no rows to clear', () => {
    clearLogs();
    expect(ringSnapshot()).toEqual([]);
  });
});
