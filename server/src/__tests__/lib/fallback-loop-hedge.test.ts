import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState, type FallbackState } from '../../lib/fallback-loop.js';
import { isHedgeAbortError, newHedgeAbortError, isClientAbortError, isRetryableError } from '../../lib/error-classify.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * Fallback-v2 hedging: when the wall-clock retry budget expires MID-FLIGHT,
 * the loop calls abortInFlight() so a stalled attempt is abandoned instead of
 * only refusing to start the next retry behind it. The surface aborts its
 * composed fetch signal with newHedgeAbortError(); the loop must render
 * timedOut exhaustion, and the provider-health bookkeeping — cooldown, skip
 * entry, logFailure row — depends on WHOSE silence spent the budget: an attempt
 * handed only the scraps a ladder left is not benched, one that stayed silent
 * for most of the whole budget is.
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

  it('benches the route when one attempt stayed silent for the whole budget', async () => {
    // The production shape behind this branch. Same ladder position as the two
    // tests above — hedging only arms from the third attempt on (#751) — but
    // here the two failures ahead of it are INSTANT, so the stalled attempt
    // inherits essentially the whole budget and then sends no first byte for
    // all of it. That is a stalled upstream, not a scheduling accident:
    // unbenched it stays at the head of the route order and re-stalls every
    // subsequent request, burning the full budget each time while the healthy
    // routes queued behind it never run.
    const state = newFallbackState();
    const hedgeAbort = new AbortController();
    const fast429 = async () => {
      throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
    };
    const dispatch = vi.fn()
      .mockImplementationOnce(fast429)
      .mockImplementationOnce(fast429)
      .mockImplementation(stalledDispatch(hedgeAbort));

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 100,
      abortInFlight: () => hedgeAbort.abort(newHedgeAbortError()),
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    // Still a timedOut exhaustion — the render is unchanged.
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted.mock.calls[0][1].timedOut).toBe(true);
    // But the stalled route now carries a cooldown and a skip entry of its own,
    // on top of the two fast 429s', so the next request routes past it. This is
    // the exact assertion that inverts for the shared-budget case above, where
    // the same three attempts produce only two of each.
    const cooldowns = getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get() as { n: number };
    expect(cooldowns.n).toBe(3);
    expect(state.skipKeys.size).toBe(3);
    expect(h.logFailure).toHaveBeenCalledTimes(3);
  });

  it('never cancels an attempt that already committed, however long it then runs', async () => {
    // The whole point of the hedge is to kill a SILENT attempt. Once a stream
    // has flushed its headers the answer is already reaching the client and the
    // loop could not fail over anyway, so cancelling would truncate a healthy
    // response for nothing. Slow != stalled.
    const state = newFallbackState();
    const abortInFlight = vi.fn();
    const dispatch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      .mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 30));
        throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
      })
      // Third attempt commits immediately, then keeps streaming well past the
      // 100ms budget — exactly the slow-but-healthy generation that used to be
      // truncated at the budget.
      .mockImplementation(async (_route: unknown, _attempt: number, ctx: { disarmHedge: () => void }) => {
        ctx.disarmHedge();
        await new Promise(r => setTimeout(r, 250));
        return 'committed';
      });

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 100,
      abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(3);
    // The committed attempt outlived the budget and was left alone.
    expect(abortInFlight).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
    // Only the two real 429s were booked as failures.
    expect(h.logFailure).toHaveBeenCalledTimes(2);
  });

  it('still aborts when the attempt stays silent past the budget', async () => {
    // The complement of the test above: no disarmHedge call (nothing was ever
    // flushed), so the stalled attempt is still cancelled.
    const state = newFallbackState();
    const hedgeAbort = new AbortController();
    const abortInFlight = vi.fn(() => hedgeAbort.abort(newHedgeAbortError()));
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
      abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(abortInFlight).toHaveBeenCalledTimes(1);
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted.mock.calls[0][1].timedOut).toBe(true);
  });
});

/**
 * RC3: per-attempt silent-window cap. A streaming attempt that sends no first
 * upstream byte within `attemptSilentMs` is aborted and treated as an ordinary
 * retryable stall, so the loop fails over to the next route while budget
 * remains instead of letting one dead route eat the whole budget.
 */
describe('fallback loop per-attempt silent-window cap (RC3)', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    vi.restoreAllMocks();
  });

  // Mirrors the surfaces: abortInFlight aborts the CURRENT controller and
  // installs a fresh one, so the next attempt is not born aborted.
  function perAttemptAbort() {
    let ctrl = new AbortController();
    return {
      current: () => ctrl,
      abortInFlight: vi.fn(() => { ctrl.abort(newHedgeAbortError()); ctrl = new AbortController(); }),
    };
  }
  function stallOn(ctrl: AbortController): Promise<never> {
    return new Promise((_resolve, reject) => {
      ctrl.signal.addEventListener('abort', () => reject(newHedgeAbortError()), { once: true });
    });
  }

  it('stalled provider then healthy provider => served by the healthy one within the silent-window cap', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    const dispatch = vi.fn()
      .mockImplementationOnce(() => stallOn(ab.current()))
      .mockImplementationOnce(async (_r: unknown, _a: number, ctx: { disarmHedge: () => void }) => {
        ctx.disarmHedge();
        return 'done';
      });
    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5_000,
      streaming: true,
      attemptSilentMs: 50,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    const t0 = Date.now();
    await runFallbackLoop(h);
    const elapsed = Date.now() - t0;

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ab.abortInFlight).toHaveBeenCalledTimes(1);
    // Served well before the 5s budget: the stall cost ~one silent window.
    expect(elapsed).toBeLessThan(1_000);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
    // The stall is booked as an ordinary retryable timeout: logged, benched,
    // skipped for the rest of the request, and on the attempt trail.
    expect(h.logFailure).toHaveBeenCalledTimes(1);
    expect(h.logFailure.mock.calls[0][1].message).toMatch(/no first byte .* within 50ms/);
    expect(state.skipKeys.size).toBe(1);
    const cooldowns = getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get() as { n: number };
    expect(cooldowns.n).toBe(1);
  });

  it('applies to the #751-exempt first attempts and keeps failing over across several stalls', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    const dispatch = vi.fn()
      .mockImplementationOnce(() => stallOn(ab.current()))
      .mockImplementationOnce(() => stallOn(ab.current()))
      .mockImplementationOnce(() => stallOn(ab.current()))
      .mockImplementationOnce(async () => 'done');
    const h = hooks(state, {
      maxRetries: 6,
      timeBudgetMs: 5_000,
      streaming: true,
      attemptSilentMs: 40,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(ab.abortInFlight).toHaveBeenCalledTimes(3);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.logFailure).toHaveBeenCalledTimes(3);
  });

  it('a mid-stream stall is unaffected: the cap never cancels an attempt that saw its first byte', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    // First token arrives immediately (still uncommitted), then the stream
    // goes quiet far longer than the cap before finishing.
    const dispatch = vi.fn().mockImplementationOnce(
      async (_r: unknown, _a: number, ctx: { disarmHedge: () => void; markFirstByte?: () => void }) => {
        ctx.markFirstByte?.();
        await new Promise(r => setTimeout(r, 200));
        ctx.disarmHedge();
        await new Promise(r => setTimeout(r, 100));
        return 'done';
      },
    );
    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5_000,
      streaming: true,
      attemptSilentMs: 40,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ab.abortInFlight).not.toHaveBeenCalled();
    expect(h.logFailure).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('does not arm for non-streaming surfaces (no observable first byte)', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    const dispatch = vi.fn().mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 150));
      return 'done';
    });
    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5_000,
      attemptSilentMs: 40,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(ab.abortInFlight).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('budget exhaustion still errors correctly: stalls past the budget render timedOut exhaustion', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    // Every route stalls. Cap 40ms, budget 100ms: attempts 0..1 are capped
    // (#751-exempt from the budget), attempt 2 gets the budget remainder,
    // then the loop must stop with a timedOut exhaustion render.
    const dispatch = vi.fn().mockImplementation(() => stallOn(ab.current()));
    const h = hooks(state, {
      maxRetries: 10,
      timeBudgetMs: 100,
      streaming: true,
      attemptSilentMs: 40,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    const t0 = Date.now();
    await runFallbackLoop(h);

    expect(h.onExhausted).toHaveBeenCalledTimes(1);
    expect(h.onExhausted.mock.calls[0][1].timedOut).toBe(true);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.length).toBeLessThan(10);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('attemptSilentMs = 0 disables the cap', async () => {
    const state = newFallbackState();
    const ab = perAttemptAbort();
    const dispatch = vi.fn().mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 120));
      return 'done';
    });
    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5_000,
      streaming: true,
      attemptSilentMs: 0,
      abortInFlight: ab.abortInFlight,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(ab.abortInFlight).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });
});
