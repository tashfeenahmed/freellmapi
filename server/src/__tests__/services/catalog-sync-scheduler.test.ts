import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { startCatalogSync, stopCatalogSync } from '../../services/catalog-sync.js';
import {
  collectTelemetryStats,
  isTelemetryOptIn,
  setTelemetryOptIn,
  getTelemetryEndpoint,
  setTelemetryEndpoint,
  uploadTelemetry,
  startTelemetryUpload,
  cancelTelemetryUpload,
} from '../../services/telemetry.js';
import type { Scheduler } from '../../lib/scheduler.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const after: { ms: number; fn: () => void | Promise<void> }[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      const cancel = vi.fn();
      every.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
    after(ms, fn) {
      const cancel = vi.fn();
      after.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
  };
  return { scheduler, every, after, cancels };
}

describe('startCatalogSync / stopCatalogSync', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    stopCatalogSync();
    delete process.env.CATALOG_SYNC_DISABLED;
  });

  it('registers a 10-second boot delay and a 12-hour interval', () => {
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(after[0].ms).toBe(10 * 1000);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(12 * 60 * 60 * 1000);
  });

  it('is idempotent — double-start registers only one set of jobs', () => {
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });

  it('registers nothing when CATALOG_SYNC_DISABLED=1', () => {
    process.env.CATALOG_SYNC_DISABLED = '1';
    const { scheduler, every, after } = makeScheduler();
    startCatalogSync(scheduler);
    expect(after).toHaveLength(0);
    expect(every).toHaveLength(0);
  });

  it('stop invokes both cancel handles', () => {
    const { scheduler, cancels } = makeScheduler();
    startCatalogSync(scheduler);
    stopCatalogSync();
    expect(cancels).toHaveLength(2);
    cancels.forEach((c) => expect(c).toHaveBeenCalledOnce());
  });

  it('can re-register after stop', () => {
    const { scheduler: s1 } = makeScheduler();
    startCatalogSync(s1);
    stopCatalogSync();

    const { scheduler: s2, every, after } = makeScheduler();
    startCatalogSync(s2);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });
});

// ── Anonymized reliability telemetry (opt-in, #685 design B1) ───────────────
// The scheduler-registration tests above double as the harness for the
// telemetry uploader: same Scheduler shape, same DB. Telemetry must stay
// opt-in (nothing leaves the box by default), send only (platform, model_id,
// counts), and never crash the scheduler on a failed upload.

const realFetch = globalThis.fetch;

function addRequest(opts: {
  platform: string; modelId: string; status: string; latencyMs: number; daysAgo?: number;
}) {
  const created = opts.daysAgo
    ? new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000).toISOString()
    : new Date().toISOString();
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at)
    VALUES (?, ?, ?, 0, 0, ?, ?)
  `).run(opts.platform, opts.modelId, opts.status, opts.latencyMs, created);
}

describe('telemetry: settings', () => {
  beforeEach(() => {
    // The shared in-memory DB persists settings across tests in this file, so
    // reset the telemetry keys explicitly before each case.
    setTelemetryOptIn(false);
    setTelemetryEndpoint('');
    cancelTelemetryUpload();
  });

  it('defaults to off with no endpoint', () => {
    expect(isTelemetryOptIn()).toBe(false);
    expect(getTelemetryEndpoint()).toBe('');
  });

  it('persists opt-in and endpoint', () => {
    setTelemetryOptIn(true);
    setTelemetryEndpoint('https://telemetry.example.com/v1/collect');
    expect(isTelemetryOptIn()).toBe(true);
    expect(getTelemetryEndpoint()).toBe('https://telemetry.example.com/v1/collect');
  });
});

describe('telemetry: collectTelemetryStats', () => {
  beforeEach(() => {
    setTelemetryOptIn(true);
    getDb().exec('DELETE FROM requests');
  });

  afterEach(() => {
    cancelTelemetryUpload();
    getDb().exec('DELETE FROM requests');
  });

  it('aggregates success/failure counts and mean latency per model', () => {
    addRequest({ platform: 'groq', modelId: 'llama', status: 'success', latencyMs: 100 });
    addRequest({ platform: 'groq', modelId: 'llama', status: 'success', latencyMs: 200 });
    addRequest({ platform: 'groq', modelId: 'llama', status: 'error', latencyMs: 3000 });
    addRequest({ platform: 'google', modelId: 'gemini', status: 'success', latencyMs: 50 });

    const stats = collectTelemetryStats(getDb());
    const llama = stats.find(s => s.modelId === 'llama')!;
    expect(llama).toMatchObject({ platform: 'groq', successes: 2, failures: 1 });
    expect(llama.avgLatencyMs).toBe(150);
    const gemini = stats.find(s => s.modelId === 'gemini')!;
    expect(gemini).toMatchObject({ platform: 'google', successes: 1, failures: 0 });
    expect(gemini.avgLatencyMs).toBe(50);
  });

  it('excludes requests older than the 7-day window', () => {
    addRequest({ platform: 'groq', modelId: 'old', status: 'success', latencyMs: 100, daysAgo: 30 });
    expect(collectTelemetryStats(getDb())).toHaveLength(0);
  });
});

describe('telemetry: uploadTelemetry', () => {
  beforeEach(() => {
    setTelemetryOptIn(false);
    setTelemetryEndpoint('');
    getDb().exec('DELETE FROM requests');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    cancelTelemetryUpload();
    getDb().exec('DELETE FROM requests');
  });

  it('sends nothing when opt-in is off', async () => {
    addRequest({ platform: 'groq', modelId: 'llama', status: 'success', latencyMs: 100 });
    const mock = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = mock as any;

    const sent = await uploadTelemetry(getDb(), 'https://telemetry.example.com/v1/collect');
    expect(sent).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it('POSTs an anonymized payload to the configured endpoint', async () => {
    addRequest({ platform: 'groq', modelId: 'llama', status: 'success', latencyMs: 100 });
    addRequest({ platform: 'groq', modelId: 'llama', status: 'error', latencyMs: 500 });
    setTelemetryOptIn(true);

    const mock = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = mock as any;

    const sent = await uploadTelemetry(getDb(), 'https://telemetry.example.com/v1/collect');
    expect(sent).toBe(true);

    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).toBe('https://telemetry.example.com/v1/collect');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'content-type': 'application/json' });

    const body = JSON.parse(String((init as RequestInit).body)) as any;
    expect(body.v).toBe(1);
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ platform: 'groq', modelId: 'llama', successes: 1, failures: 1 });
    expect(typeof body.models[0].avgLatencyMs).toBe('number');
    // Privacy: only platform + model id + counts leave the box.
    expect(JSON.stringify(body)).not.toContain('key');
    expect(JSON.stringify(body)).not.toContain('http://');
  });

  it('returns false when the endpoint rejects the upload', async () => {
    addRequest({ platform: 'groq', modelId: 'llama', status: 'success', latencyMs: 100 });
    setTelemetryOptIn(true);
    const mock = vi.fn(async () => new Response('nope', { status: 500 }));
    globalThis.fetch = mock as any;

    expect(await uploadTelemetry(getDb(), 'https://telemetry.example.com/v1/collect')).toBe(false);
  });
});

describe('telemetry: startTelemetryUpload', () => {
  beforeEach(() => {
    setTelemetryOptIn(false);
    setTelemetryEndpoint('');
  });

  afterEach(() => {
    cancelTelemetryUpload();
  });

  it('registers a boot delay and a daily interval when opted in', () => {
    setTelemetryOptIn(true);
    setTelemetryEndpoint('https://telemetry.example.com/v1/collect');
    const { scheduler, every, after } = makeScheduler();

    startTelemetryUpload(scheduler, getDb());

    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
    expect(every[0]!.ms).toBe(24 * 60 * 60 * 1000);
  });

  it('registers nothing when opted out', () => {
    const { scheduler, every, after } = makeScheduler();

    startTelemetryUpload(scheduler, getDb());

    expect(after).toHaveLength(0);
    expect(every).toHaveLength(0);
  });
});
