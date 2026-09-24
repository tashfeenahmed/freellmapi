import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { newClientAbortError, newHedgeAbortError } from '../../lib/error-classify.js';
import { newFallbackState, runFallbackLoop, type FallbackHooks } from '../../lib/fallback-loop.js';
import { invalidateTtfbBudgetCache } from '../../lib/ttfb-budget.js';
import { acquireLease, inFlightForKey, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

interface Attempt {
  platform: string;
  endpointScope?: string;
  delayMs: number;
  result: 'retry' | 'done' | 'stalled' | 'stream' | 'client_abort';
}

let nextKey = 50_000;
function scenario(plan: Attempt[], overrides: Partial<FallbackHooks> = {}) {
  const controller = new AbortController();
  const routed: RouteResult[] = [];
  const hooks = {
    state: newFallbackState(),
    timeBudgetMs: 45_000,
    maxRetries: 6,
    breakerLimit: 0,
    route: vi.fn((attempt: number): RouteResult => {
      const target = plan[attempt];
      if (!target) throw new Error('no more routes');
      const keyId = ++nextKey;
      const leaseId = acquireLease(target.platform, 'test-model', keyId, 100);
      const route: RouteResult = {
        provider: {} as RouteResult['provider'],
        modelId: 'test-model',
        modelDbId: keyId,
        apiKey: 'test-key',
        keyId,
        keyLabel: null,
        platform: target.platform,
        endpointScope: target.endpointScope ?? '',
        displayName: 'Test model',
        rpdLimit: null,
        tpdLimit: null,
        release: vi.fn(() => releaseLease(leaseId)),
      };
      routed.push(route);
      return route;
    }),
    dispatch: vi.fn<FallbackHooks['dispatch']>(async (_route, attempt, ctx) => {
      const target = plan[attempt];
      if (target.result === 'stalled') {
        return await new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(newHedgeAbortError()), { once: true });
        });
      }
      await new Promise(resolve => setTimeout(resolve, target.delayMs));
      if (target.result === 'retry') throw Object.assign(new Error('rate limit'), { status: 429 });
      if (target.result === 'client_abort') throw newClientAbortError();
      if (target.result === 'stream') {
        ctx.disarmHedge();
        await new Promise(resolve => setTimeout(resolve, 100_000));
      }
      return 'done';
    }),
    abortInFlight: vi.fn(() => controller.abort(newHedgeAbortError())),
    logFailure: vi.fn(),
    onFatal: vi.fn(),
    onExhausted: vi.fn(),
    onRoutingExhausted: vi.fn(),
    ...overrides,
  };
  return { hooks, routed };
}

function history(platform: string, ttfbMs: number, endpointScope = ''): void {
  let keyId: number | null = null;
  if (endpointScope) {
    const row = getDb().prepare(`
      INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, base_url)
      VALUES (?, 'unused', 'unused', 'unused', ?)
    `).run(platform, endpointScope);
    keyId = Number(row.lastInsertRowid);
  }
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, ttfb_ms, created_at)
    VALUES (?, 'historical-model', ?, 'success', ?, ?)
  `).run(platform, keyId, ttfbMs, new Date(Date.now() - 1_000).toISOString());
}

function warmups(delayMs = 1_000): Attempt[] {
  return [
    { platform: 'warmup-a', delayMs, result: 'retry' },
    { platform: 'warmup-b', delayMs, result: 'retry' },
  ];
}

function expectReleased(routes: RouteResult[]): void {
  for (const route of routes) {
    expect(route.release).toHaveBeenCalledTimes(1);
    expect(inFlightForKey(route.platform, route.keyId)).toBe(0);
  }
}

describe('endpoint TTFB-aware fallback budget (#1262)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TTFB_BUDGET_DISABLED', '');
    vi.stubEnv('TTFB_BUDGET_MIN_SAMPLES', '1');
    vi.stubEnv('SLOW_ENDPOINT_BUFFER_MS', '10000');
    vi.stubEnv('TTFB_BUDGET_WINDOW_MS', '604800000');
    vi.stubEnv('TTFB_BUDGET_HALF_LIFE_MS', '172800000');
    initDb(':memory:');
    resetLeases();
    invalidateTtfbBudgetCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetLeases();
    invalidateTtfbBudgetCache();
  });

  it('lets a historically slow endpoint respond after the original 45s deadline', async () => {
    history('slow', 50_000);
    const { hooks, routed } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 50_000, result: 'done' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(65_000);
    await run;

    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
    expectReleased(routed);
  });

  it('uses the same widened deadline for the hedge and exhaustion message', async () => {
    history('slow', 50_000);
    const { hooks, routed } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 0, result: 'stalled' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(hooks.abortInFlight).toHaveBeenCalledTimes(1);
    expect(hooks.onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('retry time budget 60s') }),
      expect.objectContaining({ timedOut: true }),
    );
    expect(hooks.logFailure).toHaveBeenCalledTimes(3);
    expectReleased(routed);
  });

  it('checks the next endpoint allowance even when earlier attempts spent the base budget', async () => {
    history('slow', 90_000);
    const { hooks } = scenario([
      ...warmups(25_000), { platform: 'slow', delayMs: 10_000, result: 'done' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(110_000);
    await run;

    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
  });

  it('does not carry a slow endpoint allowance into a fast endpoint and releases the rejected route', async () => {
    history('slow', 90_000);
    history('fast', 1_000);
    const { hooks, routed } = scenario([
      ...warmups(),
      { platform: 'slow', delayMs: 50_000, result: 'retry' },
      { platform: 'fast', delayMs: 0, result: 'done' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;

    expect(hooks.route).toHaveBeenCalledTimes(4);
    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.onExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('retry time budget 45s') }),
      expect.objectContaining({ timedOut: true, attempts: expect.any(Array) }),
    );
    expect(hooks.onExhausted.mock.calls[0][1].attempts).toHaveLength(3);
    expectReleased(routed);
  });

  it.each(['fast', 'unknown', 'custom'])('keeps the base deadline for %s without borrowing another relay history', async (platform) => {
    history('fast', 1_000);
    history('custom', 90_000, 'https://slow-relay.example/v1');
    const { hooks } = scenario([
      ...warmups(),
      { platform, endpointScope: platform === 'custom' ? 'https://fast-relay.example/v1' : '', delayMs: 0, result: 'stalled' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(45_000);
    await run;

    expect(hooks.abortInFlight).toHaveBeenCalledTimes(1);
    expect(hooks.onExhausted.mock.calls[0][0].message).toContain('retry time budget 45s');
  });

  it('uses widened patience for the hedge health threshold, not the base budget', async () => {
    history('slow', 70_000);
    const { hooks } = scenario([
      ...warmups(20_000), { platform: 'slow', delayMs: 0, result: 'stalled' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(80_000);
    await run;

    // The final attempt owned 40s of an 80s budget, not 40s of 45s.
    expect(hooks.logFailure).toHaveBeenCalledTimes(2);
    expect(hooks.state.skipKeys.size).toBe(2);
    expect(hooks.onExhausted.mock.calls[0][1].timedOut).toBe(true);
  });

  it('still disarms the hedge after the first usable stream response', async () => {
    history('slow', 50_000);
    const { hooks, routed } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 50_000, result: 'stream' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(160_000);
    await run;

    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
    expectReleased(routed);
  });

  it('does not re-enable a disabled base budget', async () => {
    history('slow', 50_000);
    const { hooks } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 150_000, result: 'done' },
    ], { timeBudgetMs: 0 });
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(160_000);
    await run;

    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
  });

  it('restores the base deadline when adaptation is disabled', async () => {
    history('slow', 90_000);
    vi.stubEnv('TTFB_BUDGET_DISABLED', '1');
    const { hooks } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 0, result: 'stalled' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(45_000);
    await run;

    expect(hooks.onExhausted.mock.calls[0][0].message).toContain('retry time budget 45s');
  });

  it('keeps the runtime base setting as a floor above a learned allowance', async () => {
    history('slow', 50_000);
    setSetting('fallback_time_budget_ms', '120000');
    const { hooks } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 0, result: 'stalled' },
    ], { timeBudgetMs: undefined });
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(hooks.onExhausted.mock.calls[0][0].message).toContain('retry time budget 120s');
  });

  it('stops on a client abort during the extended window without benching it', async () => {
    history('slow', 90_000);
    const { hooks, routed } = scenario([
      ...warmups(), { platform: 'slow', delayMs: 50_000, result: 'client_abort' },
    ]);
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(110_000);
    await run;

    expect(hooks.dispatch).toHaveBeenCalledTimes(3);
    expect(hooks.logFailure).toHaveBeenCalledTimes(2);
    expect(hooks.abortInFlight).not.toHaveBeenCalled();
    expect(hooks.onExhausted).not.toHaveBeenCalled();
    expectReleased(routed);
  });

  it('preserves timeout exhaustion when routing is also exhausted after the base deadline', async () => {
    const { hooks } = scenario(warmups(25_000));
    const run = runFallbackLoop(hooks);
    await vi.advanceTimersByTimeAsync(50_000);
    await run;

    expect(hooks.onExhausted.mock.calls[0][1].timedOut).toBe(true);
    expect(hooks.onRoutingExhausted).not.toHaveBeenCalled();
  });
});
