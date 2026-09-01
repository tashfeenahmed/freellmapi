import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Durable per-attempt routing traces (P2 #15): the fallback loop records every
// dispatched attempt — failures AND the successful final one — with timing and
// outcome, and persists them to `request_attempts` keyed to the terminal
// `requests` row, in one insert batch after the response finishes. Children
// are pruned with their parents (ON DELETE CASCADE + foreign_keys=ON).

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState, type FallbackHooks } from '../../lib/fallback-loop.js';
import { logRequest } from '../../lib/request-log.js';
import { pruneRequestAnalytics } from '../../services/request-retention.js';
import type { RouteResult } from '../../services/router.js';

// Distinct keyId AND modelDbId per fake route: the router's penalty map and the
// cooldown store are module-global, so shared ids would leak state across tests.
let keySeq = 900;
function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: 787000 + n, apiKey: 'k',
    keyId: n, keyLabel: null, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
    ...overrides,
  };
}

function hooksSkeleton(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => { throw new Error('unexpected onFatal'); },
    onRoutingExhausted: () => { throw new Error('unexpected onRoutingExhausted'); },
    onExhausted: () => { throw new Error('unexpected onExhausted'); },
    ...overrides,
  };
}

interface AttemptRow {
  request_id: number;
  ordinal: number;
  platform: string;
  model_id: string;
  key_ordinal: number;
  key_label: string | null;
  outcome: string;
  start_offset_ms: number;
  duration_ms: number;
  error_summary: string | null;
}

function allAttempts(): AttemptRow[] {
  return getDb().prepare(
    'SELECT request_id, ordinal, platform, model_id, key_ordinal, key_label, outcome, start_offset_ms, duration_ms, error_summary FROM request_attempts ORDER BY ordinal',
  ).all() as AttemptRow[];
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  mockCheckKeyHealth.mockReset();
  mockCheckKeyHealth.mockResolvedValue('invalid');
  const db = getDb();
  db.prepare('DELETE FROM request_attempts').run();
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
});

describe('per-attempt routing traces', () => {
  it('persists the full multi-attempt ladder, ordered, with error classes and timings, keyed to the terminal success row', async () => {
    const routes = [
      fakeRoute({ platform: 'groq', modelId: 'llama-x' }),
      fakeRoute({ platform: 'google', modelId: 'gemini-y' }),
      fakeRoute({ platform: 'cerebras', modelId: 'qwen-z' }),
    ];

    await runFallbackLoop(hooksSkeleton({
      route: (attempt) => routes[Math.min(attempt, routes.length - 1)],
      dispatch: async (route, attempt) => {
        await new Promise(r => setTimeout(r, 10));
        if (attempt === 0) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        if (attempt === 1) throw new Error('upstream timeout after 10000ms');
        logRequest(route.platform, route.modelId, route.keyId, 'success', 10, 5, 42, null);
        return 'done';
      },
      logFailure: (route, err) =>
        logRequest(route.platform, route.modelId, route.keyId, 'error', 10, 0, 5, err.message),
    }));

    const successRow = getDb().prepare("SELECT id FROM requests WHERE status = 'success'").get() as { id: number };
    const rows = allAttempts();

    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.ordinal)).toEqual([0, 1, 2]);
    expect(rows.map(r => r.outcome)).toEqual(['rate_limited', 'timeout', 'ok']);
    expect(rows.map(r => r.platform)).toEqual(['groq', 'google', 'cerebras']);
    expect(rows.map(r => r.model_id)).toEqual(['llama-x', 'gemini-y', 'qwen-z']);
    // Per-request key ordinals, never raw key ids.
    expect(rows.map(r => r.key_ordinal)).toEqual([1, 2, 3]);
    // Every attempt hangs off the SAME parent: the terminal success row.
    expect(new Set(rows.map(r => r.request_id))).toEqual(new Set([successRow.id]));

    // Timing: offsets are ladder-relative and monotonic; each attempt ran
    // for at least its simulated 10ms.
    expect(rows[0].start_offset_ms).toBeGreaterThanOrEqual(0);
    expect(rows[1].start_offset_ms).toBeGreaterThan(rows[0].start_offset_ms);
    expect(rows[2].start_offset_ms).toBeGreaterThan(rows[1].start_offset_ms);
    for (const r of rows) expect(r.duration_ms).toBeGreaterThanOrEqual(5);

    // The mid-ladder failure rows carry no children of their own.
    const errorIds = getDb().prepare("SELECT id FROM requests WHERE status = 'error'").all() as { id: number }[];
    expect(errorIds).toHaveLength(2);
    for (const { id } of errorIds) {
      const c = getDb().prepare('SELECT COUNT(*) as c FROM request_attempts WHERE request_id = ?').get(id) as { c: number };
      expect(c.c).toBe(0);
    }
  });

  it('snapshots the operator-facing key label per attempt, and leaves it null for unlabeled keys (#869)', async () => {
    const routes = [
      fakeRoute({ platform: 'groq', modelId: 'llama-x', keyLabel: 'work laptop' }),
      fakeRoute({ platform: 'groq', modelId: 'llama-x', keyLabel: null }),
      fakeRoute({ platform: 'cerebras', modelId: 'qwen-z', keyLabel: 'billing account' }),
    ];

    await runFallbackLoop(hooksSkeleton({
      route: (attempt) => routes[Math.min(attempt, routes.length - 1)],
      dispatch: async (route, attempt) => {
        if (attempt < 2) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        logRequest(route.platform, route.modelId, route.keyId, 'success', 10, 5, 42, null);
        return 'done';
      },
      logFailure: (route, err) =>
        logRequest(route.platform, route.modelId, route.keyId, 'error', 10, 0, 5, err.message),
    }));

    const rows = allAttempts();
    expect(rows.map(r => r.key_label)).toEqual(['work laptop', null, 'billing account']);
    // The label is the operator's own name for the key, never the internal key
    // id and never the credential.
    const keyIds = routes.map(r => String(r.keyId));
    for (const r of rows) {
      if (r.key_label === null) continue;
      expect(keyIds).not.toContain(r.key_label);
      expect(r.key_label).not.toBe(routes[0].apiKey);
    }
  });

  it('persists a redacted, capped error_summary per failed attempt and null for the successful one', async () => {
    const longTail = ' then the provider rambled on'.repeat(20);
    await runFallbackLoop(hooksSkeleton({
      route: () => fakeRoute({ platform: 'groq', modelId: 'llama-x' }),
      dispatch: async (route, attempt) => {
        if (attempt === 0) {
          throw Object.assign(
            new Error(`429 rejected: Bearer sk-secret.token-12345 over quota${longTail}`),
            { status: 429 },
          );
        }
        logRequest(route.platform, route.modelId, route.keyId, 'success', 10, 5, 42, null);
        return 'done';
      },
      logFailure: (route, err) =>
        logRequest(route.platform, route.modelId, route.keyId, 'error', 10, 0, 5, err.message),
    }));

    const rows = allAttempts();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.outcome)).toEqual(['rate_limited', 'ok']);

    // Failed hop: short, redacted, capped summary — never the raw secret.
    const summary = rows[0].error_summary;
    expect(summary).toBeTruthy();
    expect(summary!).toContain('429');
    expect(summary!).not.toContain('sk-secret.token-12345');
    expect(summary!.length).toBeLessThanOrEqual(200);

    // Successful hop: no error, no summary.
    expect(rows[1].error_summary).toBeNull();
  });

  it("persists exactly one 'ok' attempt for a single-attempt success", async () => {
    const route = fakeRoute({ platform: 'groq', modelId: 'solo-model' });
    await runFallbackLoop(hooksSkeleton({
      route: () => route,
      dispatch: async () => {
        logRequest(route.platform, route.modelId, route.keyId, 'success', 3, 7, 11, null);
        return 'done';
      },
    }));

    const parent = getDb().prepare("SELECT id FROM requests WHERE status = 'success'").get() as { id: number };
    const rows = allAttempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: parent.id,
      ordinal: 0,
      platform: 'groq',
      model_id: 'solo-model',
      key_ordinal: 1,
      outcome: 'ok',
    });
    // Wall-clock delta between trace start and first dispatch: 0 on a fast
    // machine, a few ms on a loaded CI runner — assert small, not exactly 0
    // (flaked on the Node 22 CI job).
    expect(rows[0].start_offset_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0].start_offset_ms).toBeLessThan(1000);
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('persists the failure ladder keyed to the last error row when every attempt fails', async () => {
    await runFallbackLoop(hooksSkeleton({
      maxRetries: 2,
      route: () => fakeRoute({ platform: 'fake', modelId: 'always-429' }),
      dispatch: async () => {
        throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      },
      logFailure: (route, err) =>
        logRequest(route.platform, route.modelId, route.keyId, 'error', 1, 0, 5, err.message),
      onExhausted: () => {},
    }));

    const lastErrorRow = getDb().prepare('SELECT id FROM requests ORDER BY id DESC LIMIT 1').get() as { id: number };
    const rows = allAttempts();
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.outcome)).toEqual(['rate_limited', 'rate_limited']);
    expect(new Set(rows.map(r => r.request_id))).toEqual(new Set([lastErrorRow.id]));
  });

  it('prunes request_attempts rows with their parent requests rows (retention)', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES ('test', 'old-model', 'success', 1, 1, 1, NULL, '2020-01-01 00:00:00')
    `).run();
    const parent = db.prepare('SELECT id FROM requests ORDER BY id DESC LIMIT 1').get() as { id: number };
    db.prepare(`
      INSERT INTO request_attempts (request_id, ordinal, platform, model_id, key_ordinal, outcome, start_offset_ms, duration_ms)
      VALUES (?, 0, 'test', 'old-model', 1, 'rate_limited', 0, 12), (?, 1, 'test', 'old-model', 2, 'ok', 20, 30)
    `).run(parent.id, parent.id);
    expect(allAttempts()).toHaveLength(2);

    const { deleted } = pruneRequestAnalytics({ force: true });
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM requests WHERE id = ?').get(parent.id)).toEqual({ c: 0 });
    expect(allAttempts()).toHaveLength(0);
  });
});
