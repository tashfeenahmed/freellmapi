import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  acquireLease,
  releaseLease,
  resetLeases,
  inFlightForKey,
  canUseKeyConcurrency,
  getKeyConcurrencyLimit,
} from '../../services/ratelimit.js';

/**
 * In-flight leases make the window between key selection and usage recording
 * visible. They back the per-key concurrency cap, which stops parallel streams
 * from all picking one key and 429-ing each other on providers that meter
 * concurrency per credential.
 */
describe('in-flight leases', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
  });

  afterEach(() => {
    resetLeases();
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY;
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
    delete process.env.PROVIDER_TIMEOUT_GROQ;
    vi.useRealTimers();
  });

  it('counts only the matching platform and key', () => {
    acquireLease('groq', 'llama-3.3-70b', 1, 100);
    acquireLease('groq', 'llama-3.1-8b', 1, 100);
    acquireLease('groq', 'llama-3.3-70b', 2, 100);
    acquireLease('cerebras', 'qwen-3-coder', 1, 100);

    expect(inFlightForKey('groq', 1)).toBe(2);
    expect(inFlightForKey('groq', 2)).toBe(1);
    expect(inFlightForKey('cerebras', 1)).toBe(1);
    expect(inFlightForKey('groq', 99)).toBe(0);
  });

  it('release frees the slot and is idempotent', () => {
    const id = acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(inFlightForKey('groq', 1)).toBe(1);

    releaseLease(id);
    expect(inFlightForKey('groq', 1)).toBe(0);
    // Overlapping cleanup paths must not double-decrement someone else's slot.
    releaseLease(id);
    releaseLease(id);
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  // #1878: the slow platforms allow a 120s attempt and a stream outlives its
  // headers, so a live lease must survive the old flat two-minute mark.
  it('keeps a lease past two minutes while the platform call may still be running', () => {
    vi.useFakeTimers();
    acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(inFlightForKey('groq', 1)).toBe(1);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(inFlightForKey('groq', 1)).toBe(1);
  });

  it('keeps a lease for a ten-minute call (AMD Radeon is built with a 600s timeout)', () => {
    vi.useFakeTimers();
    acquireLease('radeon', 'some-reasoning-model', 1, 100);
    vi.advanceTimersByTime(12 * 60 * 1000);
    expect(inFlightForKey('radeon', 1)).toBe(1);
  });

  it('never ages out a lease for a platform configured with no timeout', () => {
    vi.useFakeTimers();
    process.env.PROVIDER_TIMEOUT_GROQ = '0';
    acquireLease('groq', 'llama-3.3-70b', 1, 100);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(inFlightForKey('groq', 1)).toBe(1);
  });

  it('ages out a leaked lease so a key cannot be blocked forever', () => {
    vi.useFakeTimers();
    acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(inFlightForKey('groq', 1)).toBe(1);

    // Past the backstop age (30 min floor for a 120s platform timeout).
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(inFlightForKey('groq', 1)).toBe(0);
  });
});

describe('per-key concurrency cap', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
  });

  afterEach(() => {
    resetLeases();
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY;
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
  });

  it('is unlimited by default — capping every provider would cost throughput', () => {
    expect(getKeyConcurrencyLimit('groq')).toBeNull();
    for (let i = 0; i < 25; i++) acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('reads a per-platform env cap ahead of the global one', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY = '5';
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '2';
    expect(getKeyConcurrencyLimit('groq')).toBe(2);
    expect(getKeyConcurrencyLimit('cerebras')).toBe(5);
  });

  it('ignores a malformed cap rather than blocking everything', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = 'not-a-number';
    expect(getKeyConcurrencyLimit('groq')).toBeNull();
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '0';
    expect(getKeyConcurrencyLimit('groq')).toBeNull();
  });

  it('blocks a key at its cap and frees it on release', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';

    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
    const id = acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);

    releaseLease(id);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('caps each key independently, so a sibling key stays available', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';
    acquireLease('groq', 'llama-3.3-70b', 1, 100);

    // This is the point: the request fails over to key 2 instead of queueing
    // behind key 1 and collecting a 429.
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);
    expect(canUseKeyConcurrency('groq', 2)).toBe(true);
  });

  it('counts a key busy on one model against a request for another', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';
    acquireLease('groq', 'llama-3.3-70b', 1, 100);
    // Concurrency is metered per credential, not per model.
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);
  });

  it('allows up to the cap and no further', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '3';
    const ids = [0, 1, 2].map(() => acquireLease('groq', 'llama-3.3-70b', 1, 100));
    expect(inFlightForKey('groq', 1)).toBe(3);
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);

    releaseLease(ids[0]!);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });
});
