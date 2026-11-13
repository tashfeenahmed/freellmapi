// model-probe tests (#1438 PR 1): candidate selection (stalest-first, fresh
// real-traffic skip), label recording, per-pass budget, restart stagger +
// first-sighting scheduling, failed-probe backoff, transport-error
// inconclusiveness (verdict preserved), and the kill switch.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  selectProbeCandidates,
  probeModel,
  recordProbeResult,
  runModelProbePass,
  resetModelProbeState,
  startModelProbe,
  stopModelProbe,
  MODEL_PROBE_STALE_MS,
} from '../../services/model-probe.js';
import type { ProbeCandidate } from '../../services/model-probe.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetModelProbeState();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM models').run();
  // Fresh healthy key the models can hang off.
  db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
              VALUES (1, 'probe-test', '', '', '', '', 'healthy', 1)`).run();
});

function addModel(id: number, modelId: string, opts: { enabled?: number } = {}): void {
  getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                   VALUES (?, 'probe-test', ?, ?, 0, 0, '', ?)`).run(id, modelId, modelId, opts.enabled ?? 1);
}

const candidate = (over: Partial<ProbeCandidate> = {}): ProbeCandidate => ({
  keyId: 1,
  platform: 'probe-test',
  modelId: 'm1',
  modelDbId: 1,
  endpointScope: '',
  ...over,
});

// Seed one pass' worth of candidates so stagger/backoff choreography is
// deterministic: first sighting schedules (no probe), next pass probes.
function seedCandidates(n: number): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  for (let i = 1; i <= n; i++) {
    addModel(i, `m${i}`);
    out.push(candidate({ modelId: `m${i}`, modelDbId: i }));
  }
  return out;
}

const selectFrom = (list: ProbeCandidate[]) => (limit: number) => list.slice(0, limit);
const chatOk = () => vi.fn(async () => ({}));
const chatFail = (message: string) => vi.fn(async () => { throw new Error(message); });
const noJitter = () => 0;

describe('candidate selection', () => {
  it('probes the stalest evidence first, never-probed before stale', () => {
    const db = getDb();
    addModel(1, 'old');
    addModel(2, 'fresh');
    addModel(3, 'never');
    recordProbeResult(db, candidate({ modelId: 'old', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date(Date.now() - MODEL_PROBE_STALE_MS - 1000));
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 2 }),
      { status: 'working', latencyMs: 5 }, new Date());

    const picked = selectProbeCandidates(db, 10);
    expect(picked.map(p => p.modelId)).toEqual(['never', 'old']);
  });

  it('skips models with fresh evidence (staleness window)', () => {
    const db = getDb();
    addModel(1, 'fresh');
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date());
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });

  it('ignores disabled models and disabled/invalid keys', () => {
    const db = getDb();
    addModel(1, 'off-model', { enabled: 0 });
    addModel(2, 'bad-key-model');
    db.prepare("UPDATE api_keys SET status = 'invalid' WHERE id = 1").run();
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });
});

describe('probe outcome classification', () => {
  it('a successful chat is working with latency', async () => {
    const outcome = await probeModel(candidate(), { chat: chatOk() });
    expect(outcome.status).toBe('working');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a provider rejection is unavailable and carries the sanitized error', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('403: quota exhausted upstream') });
    expect(outcome.status).toBe('unavailable');
    expect(outcome.error).toContain('403');
  });

  it('a transport error is inconclusive (error), never unavailable', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('fetch failed: getaddrinfo ENOTFOUND api.example.com') });
    expect(outcome.status).toBe('error');
  });
});

describe('recording', () => {
  it('writes working with latency and clears prior errors', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'unavailable', error: '403' });
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 42 });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.latency_ms).toBe(42);
    expect(row.last_error).toBeNull();
  });

  it('an inconclusive probe preserves the previous verdict', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 10 });
    recordProbeResult(db, candidate(), { status: 'error', error: 'fetch failed' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.last_error).toBe('fetch failed');
  });
});

describe('probe pass', () => {
  it('first sighting schedules instead of probing; the next pass probes within budget', async () => {
    const list = seedCandidates(5);
    const chat = chatOk();
    const pass1 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass1.probed).toEqual([]);
    expect(chat).not.toHaveBeenCalled();

    const pass2 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('a working probe clears pacing so the model is not re-probed until stale', async () => {
    const list = seedCandidates(1);
    const chat = chatOk;
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Third pass: the single candidate just worked; nothing is probeable.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
  });

  it('an unavailable probe backs off instead of re-probing every pass', async () => {
    const list = seedCandidates(1);
    const chat = chatFail('403 quota');
    // Pass 1: first sighting only schedules.
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Pass 2: the actual probe — fails, sets a 30m backoff.
    const pass2 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(1);
    // Pass 3 immediately after: still inside the backoff, nothing probed.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
    // Past the first backoff step (30m) it probes again.
    const later = Date.now() + 31 * 60_000;
    const pass4 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list), now: later });
    expect(pass4.probed).toHaveLength(1);
  });

  it('records outcomes in the table', async () => {
    const list = seedCandidates(2);
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    const rows = getDb().prepare('SELECT model_id, status FROM model_probe_status ORDER BY model_id').all() as any[];
    expect(rows).toEqual([
      { model_id: 'm1', status: 'working' },
      { model_id: 'm2', status: 'working' },
    ]);
  });
});

describe('kill switch and lifecycle', () => {
  it('is off by default: the scheduler does not start without MODEL_PROBE_ENABLED=1', () => {
    delete process.env.MODEL_PROBE_ENABLED;
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).not.toHaveBeenCalled();
    stopModelProbe();
  });

  it('MODEL_PROBE_ENABLED=1 schedules the job on the 30m cadence', () => {
    process.env.MODEL_PROBE_ENABLED = '1';
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).toHaveBeenCalledTimes(1);
    expect(scheduler.every.mock.calls[0][0]).toBe(30 * 60 * 1000);
    delete process.env.MODEL_PROBE_ENABLED;
    stopModelProbe();
  });
});
