import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// M02: a cooldown bench is a small state machine per (platform, model, key):
// none | active(source, expiry). setCooldown used to overwrite it outright, so a
// transient 90s heuristic bench (truncation, auth blip, empty completion) landing
// on a 24h credit/tier/Retry-After bench shortened it AND made it probe-eligible.
// The merge rule: the later expiry wins, and a provider fact ('authoritative',
// 'credit', 'tier') is never downgraded to our own guess ('heuristic').

import { initDb, getDb } from '../../db/index.js';
import {
  setCooldown,
  setRetryAfterCooldown,
  isOnCooldown,
  getProbeableCooldowns,
  type CooldownSource,
} from '../../services/ratelimit.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);

let keySeq = 20_000;
const nextKey = () => ++keySeq;

function row(keyId: number): { expires_at_ms: number; source: CooldownSource; set_at_ms: number | null } {
  return getDb()
    .prepare('SELECT expires_at_ms, source, set_at_ms FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?')
    .get('groq', 'm', keyId) as { expires_at_ms: number; source: CooldownSource; set_at_ms: number | null };
}
const probeable = (keyId: number) => getProbeableCooldowns().some(c => c.keyId === keyId);

beforeAll(() => { initDb(':memory:'); });
afterEach(() => { vi.useRealTimers(); });

function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
}

describe('setCooldown keeps the stronger bench', () => {
  it.each<CooldownSource>(['authoritative', 'credit', 'tier'])(
    'a short heuristic bench does not shorten or downgrade a %s bench',
    source => {
      const k = nextKey();
      at(T0);
      setCooldown('groq', 'm', k, DAY, source);
      at(T0 + MINUTE);
      setCooldown('groq', 'm', k, 90_000, 'heuristic');
      expect(row(k)).toEqual({ expires_at_ms: T0 + DAY, source, set_at_ms: T0 });
      expect(probeable(k)).toBe(false);
      at(T0 + 10 * MINUTE);
      expect(isOnCooldown('groq', 'm', k)).toBe(true);
    },
  );

  it('a longer heuristic bench extends a heuristic one and restarts its age', () => {
    const k = nextKey();
    at(T0);
    setCooldown('groq', 'm', k, 90_000, 'heuristic');
    at(T0 + MINUTE);
    setCooldown('groq', 'm', k, 10 * MINUTE, 'heuristic');
    expect(row(k)).toEqual({ expires_at_ms: T0 + 11 * MINUTE, source: 'heuristic', set_at_ms: T0 + MINUTE });
  });

  it('a shorter heuristic bench leaves a longer heuristic one untouched', () => {
    const k = nextKey();
    at(T0);
    setCooldown('groq', 'm', k, HOUR, 'heuristic');
    at(T0 + MINUTE);
    setCooldown('groq', 'm', k, 90_000, 'heuristic');
    expect(row(k)).toEqual({ expires_at_ms: T0 + HOUR, source: 'heuristic', set_at_ms: T0 });
  });

  it('a provider fact landing on a longer heuristic bench keeps the expiry and stops probes', () => {
    // Clearing that bench early would re-hammer a provider inside the window it
    // told us to stay out of.
    const k = nextKey();
    at(T0);
    setCooldown('groq', 'm', k, HOUR, 'heuristic');
    at(T0 + MINUTE);
    setCooldown('groq', 'm', k, 5 * MINUTE, 'authoritative');
    expect(row(k)).toEqual({ expires_at_ms: T0 + HOUR, source: 'authoritative', set_at_ms: T0 });
    expect(probeable(k)).toBe(false);
  });

  it('between two provider facts, the later expiry decides the source', () => {
    const k = nextKey();
    at(T0);
    setCooldown('groq', 'm', k, HOUR, 'tier');
    at(T0 + MINUTE);
    setCooldown('groq', 'm', k, DAY, 'credit');
    expect(row(k)).toEqual({ expires_at_ms: T0 + MINUTE + DAY, source: 'credit', set_at_ms: T0 + MINUTE });
    at(T0 + 2 * MINUTE);
    setCooldown('groq', 'm', k, HOUR, 'tier');
    expect(row(k).source).toBe('credit');
  });

  it('an expired bench is replaced outright', () => {
    const k = nextKey();
    at(T0);
    setCooldown('groq', 'm', k, MINUTE, 'credit');
    at(T0 + 2 * MINUTE);
    setCooldown('groq', 'm', k, 90_000, 'heuristic');
    expect(row(k)).toEqual({ expires_at_ms: T0 + 2 * MINUTE + 90_000, source: 'heuristic', set_at_ms: T0 + 2 * MINUTE });
    expect(probeable(k)).toBe(true);
  });
});

describe('setRetryAfterCooldown', () => {
  it('stores a provider-stated Retry-After as authoritative, so the prober never clears it', () => {
    const k = nextKey();
    at(T0);
    setRetryAfterCooldown('groq', 'm', k, 120_000, MINUTE);
    expect(row(k)).toEqual({ expires_at_ms: T0 + 120_000, source: 'authoritative', set_at_ms: T0 });
    expect(probeable(k)).toBe(false);
  });

  it('without a Retry-After, benches for the fallback as our own guess', () => {
    const k = nextKey();
    at(T0);
    setRetryAfterCooldown('groq', 'm', k, undefined, MINUTE);
    expect(row(k)).toEqual({ expires_at_ms: T0 + MINUTE, source: 'heuristic', set_at_ms: T0 });
    expect(probeable(k)).toBe(true);
  });
});
