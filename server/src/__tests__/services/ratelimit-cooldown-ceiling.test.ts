import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// #952 / #1049: an operator ceiling on the router's OWN cooldown guesses. Relay
// endpoints emit "busy" / "insufficient balance" for transient reasons, and a
// few of those per key used to walk a whole pool onto 24h benches. The ceiling
// caps the escalation ladder and the day-long 402/403 benches, but must never
// shorten a provider-stated retry time — that one is a fact, not a guess.

import { initDb, getSetting, setSetting } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import {
  getNextCooldownDuration,
  getCooldownCeilingMs,
  setCooldownCeilingMs,
  getPaymentRequiredCooldownMs,
  getModelForbiddenCooldownMs,
  capCooldownMs,
  COOLDOWN_CEILING_KEY,
  PAYMENT_REQUIRED_COOLDOWN_MS,
  MODEL_FORBIDDEN_COOLDOWN_MS,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let keySeq = 952_000;
function route(): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: `ceiling-model-${n}`, modelDbId: 952_000 + n,
    apiKey: 'k', keyId: n, platform: 'openrouter', displayName: 'Ceiling Model',
    rpdLimit: 50, tpdLimit: null,
  };
}
const err402 = () => Object.assign(new Error('402 Payment Required: insufficient balance'), { status: 402 });
const err403 = () => Object.assign(new Error('403 Forbidden: model not available on your tier'), { status: 403 });

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});
beforeEach(() => setCooldownCeilingMs(null));
afterEach(() => setCooldownCeilingMs(null));

describe('cooldown ceiling (#952)', () => {
  it('is unset by default and leaves the ladder and day benches untouched', () => {
    expect(getCooldownCeilingMs()).toBeNull();
    const r = route();
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(10 * MINUTE);
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(HOUR);
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(DAY);
    expect(getPaymentRequiredCooldownMs()).toBe(PAYMENT_REQUIRED_COOLDOWN_MS);
    expect(getModelForbiddenCooldownMs()).toBe(MODEL_FORBIDDEN_COOLDOWN_MS);
  });

  it('caps the escalation ladder at the ceiling', () => {
    setCooldownCeilingMs(10 * MINUTE);
    expect(getCooldownCeilingMs()).toBe(10 * MINUTE);
    const r = route();
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(10 * MINUTE);
    // 3rd and 4th hits would be 1h and 24h; the ceiling holds them at 10 min.
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(10 * MINUTE);
    expect(getNextCooldownDuration(r.platform, r.modelId, r.keyId)).toBe(10 * MINUTE);
  });

  it('caps the 402 and 403 day-long benches, keeping their provenance', () => {
    setCooldownCeilingMs(6 * HOUR);
    const credit = cooldownDecisionForError(route(), err402());
    expect(credit).toEqual({ durationMs: 6 * HOUR, source: 'credit' });
    const tier = cooldownDecisionForError(route(), err403());
    expect(tier).toEqual({ durationMs: 6 * HOUR, source: 'tier' });
  });

  it('never shortens a provider-stated Retry-After', () => {
    setCooldownCeilingMs(10 * MINUTE);
    const r = route();
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfterMs: 3 * HOUR });
    const decision = cooldownDecisionForError(r, err);
    expect(decision.source).toBe('authoritative');
    expect(decision.durationMs).toBe(3 * HOUR);
  });

  it('clears back to no cap with null and rejects out-of-range values', () => {
    setCooldownCeilingMs(HOUR);
    expect(getSetting(COOLDOWN_CEILING_KEY)).toBe(String(HOUR));
    setCooldownCeilingMs(null);
    expect(getSetting(COOLDOWN_CEILING_KEY)).toBeUndefined();
    expect(getCooldownCeilingMs()).toBeNull();
    expect(() => setCooldownCeilingMs(30_000)).toThrow(/between/);
    expect(() => setCooldownCeilingMs(DAY + 1)).toThrow(/between/);
    expect(() => setCooldownCeilingMs(90.5)).toThrow(/between/);
    expect(capCooldownMs(DAY)).toBe(DAY);
  });

  it('treats a hand-edited invalid setting as no cap', () => {
    setSetting(COOLDOWN_CEILING_KEY, 'forever');
    expect(getCooldownCeilingMs()).toBeNull();
    expect(capCooldownMs(DAY)).toBe(DAY);
  });
});
