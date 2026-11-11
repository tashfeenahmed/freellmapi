// #1877: a short heuristic bench (timeout / 5xx) must not replace a longer
// unexpired hold, and must not replace an authoritative one (Retry-After,
// daily quota, credit, tier) even when the guess is longer. Both the
// persisted row and the in-memory map are authoritative for routing:
// isOnCooldown prefers the row, and falls back to memory when the database
// cannot be read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  clearAllCooldowns,
  clearCooldownEarly,
  clearCooldownsForKey,
  getCooldownSource,
  isOnCooldown,
  setCooldown,
} from '../../services/ratelimit.js';
import type { CooldownSource } from '../../services/ratelimit.js';

const PLATFORM = 'groq';
const MODEL = 'retry-after-model';
const keyId = 1877;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TRANSIENT_MS = 90_000;
const HOLDS = ['authoritative', 'credit', 'tier'] as const;

function stored() {
  return getDb().prepare(`
    SELECT source, expires_at_ms, set_at_ms
      FROM rate_limit_cooldowns
     WHERE platform = ? AND model_id = ? AND key_id = ?
  `).get(PLATFORM, MODEL, keyId) as { source: CooldownSource; expires_at_ms: number; set_at_ms: number } | undefined;
}

function hideDb() {
  return vi.spyOn(getDb(), 'prepare').mockImplementation(() => {
    throw new Error('Database unavailable');
  });
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  clearAllCooldowns(Number.MAX_SAFE_INTEGER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  getDb().close();
});

describe('setCooldown never shortens an unexpired hold (#1877)', () => {
  it.each(HOLDS)('keeps a long %s row when a short heuristic bench arrives', (source) => {
    setCooldown(PLATFORM, MODEL, keyId, HOUR, source);
    const before = stored();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    expect(stored()).toEqual(before);
    expect(getCooldownSource(PLATFORM, MODEL, keyId)).toBe(source);
  });

  it.each(HOLDS)('keeps the in-memory %s hold after that short window', (source) => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, HOUR, source);
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    // isOnCooldown would copy the row back into memory. Hide the database so
    // this assertion sees only what setCooldown stored in the map.
    const prepare = hideDb();
    vi.advanceTimersByTime(TRANSIENT_MS + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
  });

  it.each(HOLDS)('does not replace an active %s row with a longer heuristic bench', (source) => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, HOUR, source);
    const before = stored();
    setCooldown(PLATFORM, MODEL, keyId, 2 * HOUR, 'heuristic');
    expect(stored()).toEqual(before);
  });

  it.each(HOLDS)('does not extend the in-memory %s hold up to a longer heuristic bench', (source) => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, HOUR, source);
    setCooldown(PLATFORM, MODEL, keyId, 2 * HOUR, 'heuristic');
    const prepare = hideDb();
    vi.advanceTimersByTime(HOUR + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(false);
    prepare.mockRestore();
  });

  it('does not shorten a longer heuristic bench with a later short one', () => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, 10 * MINUTE, 'heuristic');
    const before = stored();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    expect(stored()).toEqual(before);
    const prepare = hideDb();
    vi.advanceTimersByTime(TRANSIENT_MS + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
  });

  it('does not shorten a longer heuristic when a shorter authoritative hold arrives', () => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, HOUR, 'heuristic');
    const before = stored();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'authoritative');
    expect(stored()).toEqual(before);
    const prepare = hideDb();
    vi.advanceTimersByTime(TRANSIENT_MS + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
  });

  it('keeps the in-memory hold when the shortening write cannot be persisted', () => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, HOUR, 'authoritative');
    const before = stored();
    const prepare = hideDb();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    vi.advanceTimersByTime(TRANSIENT_MS + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
    expect(stored()).toEqual(before);
    expect(getCooldownSource(PLATFORM, MODEL, keyId)).toBe('authoritative');
  });

  it('extends a short heuristic when a longer authoritative hold arrives', () => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    setCooldown(PLATFORM, MODEL, keyId, HOUR, 'authoritative');
    expect(getCooldownSource(PLATFORM, MODEL, keyId)).toBe('authoritative');
    expect(stored()?.expires_at_ms).toBe(Date.now() + HOUR);
    const prepare = hideDb();
    vi.advanceTimersByTime(TRANSIENT_MS + 1_000);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
  });

  it('replaces an already-expired hold with the new bench', () => {
    vi.useFakeTimers();
    setCooldown(PLATFORM, MODEL, keyId, 1_000, 'authoritative');
    vi.advanceTimersByTime(1_001);
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    expect(getCooldownSource(PLATFORM, MODEL, keyId)).toBe('heuristic');
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    expect(stored()?.expires_at_ms).toBe(Date.now() + TRANSIENT_MS);
  });

  it('still clears a hold explicitly and accepts a later reset', () => {
    setCooldown(PLATFORM, MODEL, keyId, HOUR, 'authoritative');
    expect(clearCooldownsForKey(keyId)).toBe(1);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(false);
    expect(stored()).toBeUndefined();

    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    expect(stored()?.source).toBe('heuristic');

    clearCooldownEarly(PLATFORM, MODEL, keyId);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(false);
    expect(stored()).toBeUndefined();

    setCooldown(PLATFORM, MODEL, keyId, HOUR, 'credit');
    expect(clearAllCooldowns()).toBe(1);
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(false);
    expect(stored()).toBeUndefined();
  });

  it('records an in-memory bench when the database is down and nothing is held', () => {
    const prepare = hideDb();
    setCooldown(PLATFORM, MODEL, keyId, TRANSIENT_MS, 'heuristic');
    expect(isOnCooldown(PLATFORM, MODEL, keyId)).toBe(true);
    prepare.mockRestore();
    expect(stored()).toBeUndefined();
  });
});
