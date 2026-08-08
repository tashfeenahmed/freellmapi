import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState, type FallbackState } from '../../lib/fallback-loop.js';
import { isHedgeAbortError, newHedgeAbortError, isClientAbortError, isRetryableError } from '../../lib/error-classify.js';
import { acquireLease, releaseLease, resetLeases, inFlightForKey } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * Fallback-v2 hedging: when the wall-clock retry budget expires MID-FLIGHT,
 * the loop calls abortInFlight() so a stalled attempt is abandoned instead of
 * only refusing to start the next retry behind it. The surface aborts its
 * composed fetch signal with newHedgeAbortError(); the loop must render
 * timedOut exhaustion WITHOUT any provider-health bookkeeping — no cooldown,
 * no skip entry, no logFailure row — because the budget is spent, not the
 * provider broken.
 */

let keySeq = 900;
function leasedRoute(): { route: RouteResult; keyId: number } {
  const keyId = ++keySeq;
  const id = acquireLease('fake', 'fake-model', keyId, 100);
  return {
    keyId,
    route: {
      provider: {} as any,
      modelId: 'fake-model',
      modelDbId: 900000 + keyId,
      apiKey: 'test-key',
      keyId,
      platform: 'fake',
      displayName: 'Fake Model',
      rpdLimit: null,
      tpdLimit: null,
      release: () => releaseLease(id),
    },
  };
}

function hooks(state: FallbackState, overrides: Record<string, unknown>) {
  return {
    state,
    timeBudgetMs: 0,
    logFailure: vi.fn(),
    onFatal: vi.fn(),
    onRoutingExhausted: vi.fn(),
    onExhausted: vi.fn(),
    ...overrides,
  } as any;
}

// An upstream that hangs until the composed signal aborts, then rejects with
// the marked hedge error — mirrors what a real fetch does when the surface
// aborts its signal via abortInFlight().
function stalledDispatch(hedgeAbort: AbortController) {
  return async (): Promise<never> => {
    return await new Promise((_resolve, reject) => {
      hedgeAbort.signal.addEventListener('abort', () => reject(newHedgeAbortError()), { once: true });
    });
  };
}

describe('fallback loop time-budget hedging', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    vi.restoreAllMocks();
  });

  it('classifies the hedge error as budget-abort, not retryable or client-abort', () => {
    const err = newHedgeAbortError();
    expect(isHedgeAbortError(err)).toBe(true);
    // Must never enter the retryable ladder as a provider failure.
    expect(isRetryableError(err)).toBe(false);
    // Distinct from the client-disconnect abort — different branch in the loop.
    expect(isClientAbortError(err)).toBe(false);
  });

  it('aborts the stalled in-flight attempt when the budget expires, rendering timedOut exhaustion', async () => {
    const state = newFallbackState();
    const hedgeAbort = new AbortController();
    // First two attempts fail quickly and retryably (each ~30ms < the 100ms
    // budget, so the third attempt gets to start); the third hangs and is
    // aborted when the remaining budget (~40ms) expires mid-flight.
    const dispatch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      .mockImplementation(stalledDispatch(hedgeAbort));

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 100,
      abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    // The stalled attempt was abandoned mid-flight; the budget is spent, so
    // no fourth attempt starts.
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted.mock.calls[0][1].timedOut).toBe(true);
    // The two quick 429 failures were logged as failures; the hedge abort of
    // the third attempt must NOT add a third logFailure row, and there is no
    // fatal render or routing-exhaustion render.
    expect(h.logFailure).toHaveBeenCalledTimes(2);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onRoutingExhausted).not.toHaveBeenCalled();
  });

  it('the hedge abort adds no cooldown, no skip, no extra failure beyond the retryable attempts', async () => {
    const state = newFallbackState();
    const hedgeAbort = new AbortController();
    // Same ladder shape as above: two quick retryable failures let the third
    // attempt start, then the budget expires mid-flight and the hedge abort
    // abandons it. Hedging only arms for attempt > 1 (the first attempt and
    // the first retry always run — #751).
    const dispatch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      .mockImplementation(stalledDispatch(hedgeAbort));

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 100,
      abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
      route: () => leasedRoute().route,
      dispatch,
    });
    await runFallbackLoop(h);

    // The two 429s each produced their normal failure bookkeeping (a cooldown
    // row and a skip entry); the hedge abort must NOT add a third of either —
    // the budget expiring is not a provider-health signal.
    const cooldowns = getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get() as { n: number };
    expect(cooldowns.n).toBe(2);
    expect(state.skipKeys.size).toBe(2);
    expect(state.skipModels.size).toBe(0);
    expect(h.logFailure).toHaveBeenCalledTimes(2);
    // And the request rendered as timedOut exhaustion, not a third failure.
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted.mock.calls[0][1].timedOut).toBe(true);
  });
});
