import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState, type FallbackState } from '../../lib/fallback-loop.js';
import { isClientAbortError, newClientAbortError, isRetryableError } from '../../lib/error-classify.js';
import { acquireLease, releaseLease, resetLeases, inFlightForKey } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * Client-abort semantics in the shared fallback loop (P1 AbortSignal work):
 * when the gateway's OWN client hangs up, the composed fetch signal rejects
 * the in-flight attempt with the marked error from newClientAbortError. That
 * throw must stop the ladder immediately, release the in-flight lease via the
 * existing finally, and leave NO provider-failure trace — no cooldown, no
 * skip-key entry, no logFailure row, no exhaustion render. What it DOES leave
 * (#752) is a 'canceled' requests row, so the dashboard shows the request
 * happened; stats/scoring queries exclude that status everywhere.
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

describe('fallback loop on client abort', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    vi.restoreAllMocks();
  });

  it('classifies the marked error as client-abort, and not as retryable', () => {
    const err = newClientAbortError();
    expect(isClientAbortError(err)).toBe(true);
    // Must never enter the retryable ladder as a provider failure.
    expect(isRetryableError(err)).toBe(false);
    // Ordinary aborts/timeouts keep their provider-timeout classification.
    expect(isClientAbortError(new DOMException('The operation was aborted (groq, chat, 15s)', 'AbortError'))).toBe(false);
  });

  it('stops the ladder immediately — no further attempts, nothing rendered', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn(async () => { throw newClientAbortError(); });
    const h = hooks(state, {
      maxRetries: 5,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    // The socket is gone: no exhaustion body, no fatal render, no error row.
    expect(h.logFailure).not.toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onRoutingExhausted).not.toHaveBeenCalled();
  });

  it('releases the in-flight lease (mid-stream abort surfaces as a dispatch throw)', async () => {
    const state = newFallbackState();
    const { route, keyId } = leasedRoute();
    // Mirror a stream pump: one chunk is consumed, then the client hangs up
    // and the next upstream read rejects with the marked abort.
    async function* abortedStream() {
      yield { choices: [{ delta: { content: 'hel' } }] };
      throw newClientAbortError();
    }
    await runFallbackLoop(hooks(state, {
      route: () => route,
      dispatch: async () => {
        for await (const _chunk of abortedStream()) { /* pump until the abort */ }
        return 'done' as const;
      },
    }));

    expect(inFlightForKey('fake', keyId)).toBe(0);
  });

  it('records no cooldown, no skip entry, and no failure bookkeeping', async () => {
    const state = newFallbackState();
    const { route, keyId } = leasedRoute();
    await runFallbackLoop(hooks(state, {
      route: () => route,
      dispatch: async () => { throw newClientAbortError(); },
    }));

    // No cooldown row: a vanished client is not a provider-health signal.
    const cooldown = getDb().prepare('SELECT 1 FROM rate_limit_cooldowns WHERE platform = ? AND key_id = ?').get('fake', keyId);
    expect(cooldown).toBeUndefined();
    // No per-request skip state either — nothing was "tried and failed".
    expect(state.skipKeys.size).toBe(0);
    expect(state.skipModels.size).toBe(0);
  });

  it("writes a 'canceled' requests row so the abort is visible in the dashboard (#752)", async () => {
    const state = newFallbackState();
    const { route } = leasedRoute();
    await runFallbackLoop(hooks(state, {
      route: () => route,
      dispatch: async () => { throw newClientAbortError(); },
    }));

    const row = getDb().prepare(
      'SELECT id, platform, model_id, key_id, status, error FROM requests ORDER BY id DESC LIMIT 1',
    ).get() as any;
    expect(row).toMatchObject({ platform: 'fake', model_id: 'fake-model', status: 'canceled' });
    expect(row.error).toContain('client disconnected');
    expect(row.error).toContain('upstream request canceled');
    // The attempt trace persists too, keyed to the canceled row — pure aborts
    // used to leave no parent row and therefore no ladder either.
    const attempts = getDb().prepare('SELECT outcome FROM request_attempts WHERE request_id = ?').all(row.id) as any[];
    expect(attempts.map(a => a.outcome)).toEqual(['client_abort']);
  });

  it('clientGone still stops the loop before the next attempt after an ordinary failure', async () => {
    // The pre-existing boundary: a NON-abort provider failure that lands after
    // the disconnect is still recorded normally, but the loop must not start
    // another attempt for a client that is gone.
    const state = newFallbackState();
    const dispatch = vi.fn(async () => {
      throw Object.assign(new Error('fake API error 429: rate limit'), { status: 429 });
    });
    let gone = false;
    await runFallbackLoop(hooks(state, {
      maxRetries: 5,
      clientGone: () => gone,
      route: () => leasedRoute().route,
      dispatch: async () => {
        gone = true; // client vanishes during the first attempt
        return dispatch();
      },
    }));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Provider error text is upstream-controlled and reaches us verbatim
  // (openai-compat: `${name} API error ${status}: ${body}`). A relay that
  // answers "499 client disconnected" about ITS OWN upstream must not pass for
  // our client hanging up: that path renders nothing, so the live client hung.
  it('does not take upstream "client disconnected" text for our client hanging up', () => {
    expect(isClientAbortError(new Error('Fake API error 499: client disconnected'))).toBe(false);
    expect(isClientAbortError(new Error('upstream: Client Disconnected before response'))).toBe(false);
  });

  it('still recognises our own abort when re-wrapped or stringified', () => {
    const ours = newClientAbortError();
    expect(isClientAbortError(new Error('outer', { cause: new Error('middle', { cause: ours }) }))).toBe(true);
    expect(isClientAbortError(new Error(`Fake stream error: ${ours.message}`))).toBe(true);
  });

  it('fails over and answers the client when upstream text says "client disconnected"', async () => {
    const state = newFallbackState();
    const dispatch = vi.fn()
      .mockImplementationOnce(async () => { throw Object.assign(new Error('Fake API error 500: client disconnected'), { status: 500 }); })
      .mockImplementationOnce(async () => 'done');
    const h = hooks(state, {
      maxRetries: 3,
      clientGone: () => false,
      route: () => leasedRoute().route,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(h.logFailure).toHaveBeenCalledTimes(1);
  });
});
