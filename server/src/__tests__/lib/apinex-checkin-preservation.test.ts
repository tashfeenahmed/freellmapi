import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { newFallbackState, recordRetryableFailure } from '../../lib/fallback-loop.js';
import {
  clearAllCooldowns, clearApinexCheckinCooldownsForKey, getCooldownSource,
  getProbeableCooldowns, isOnCooldown, setCooldown,
} from '../../services/ratelimit.js';
import type { CooldownSource } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const keyId = 760501;
const heldModels = ['authoritative-route', 'credit-route', 'tier-route'];
const checkin = Object.assign(new Error('APINex API error 402: Daily check-in required'), { status: 402 });
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  for (const model of ['checkin-route', ...heldModels]) {
    getDb().prepare("INSERT INTO models (platform,model_id,display_name,intelligence_rank,speed_rank,enabled) VALUES ('apinex',?,?,50,5,1)").run(model, model);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });
function route(modelId = 'checkin-route'): RouteResult {
  const row = getDb().prepare("SELECT id FROM models WHERE platform='apinex' AND model_id=?").get(modelId) as { id: number };
  return { provider: {} as any, platform: 'apinex', modelId, modelDbId: row.id, keyId,
    apiKey: 'not-a-real-key', keyLabel: null, displayName: 'test', contextWindow: null,
    endpointScope: '', rpdLimit: null, tpdLimit: null };
}
function stored(modelId: string) {
  return getDb().prepare("SELECT source,expires_at_ms,set_at_ms FROM rate_limit_cooldowns WHERE platform='apinex' AND model_id=? AND key_id=?").get(modelId, keyId);
}

describe('APINex check-in cooldown preservation', () => {
  it('preserves genuine sibling holds through a real failure followed by Resume key', () => {
    heldModels.forEach((model, i) => setCooldown('apinex', model, keyId, 60 * 60_000, ['authoritative', 'credit', 'tier'][i] as CooldownSource));
    const before = heldModels.map(stored);
    recordRetryableFailure(route(), checkin, newFallbackState());
    expect(heldModels.map(stored)).toEqual(before);
    expect(getCooldownSource('apinex', 'checkin-route', keyId)).toBe('checkin');
    expect(clearApinexCheckinCooldownsForKey(keyId)).toBe(1);
    expect(isOnCooldown('apinex', 'checkin-route', keyId)).toBe(false);
    expect(heldModels.map(stored)).toEqual(before);
    heldModels.forEach(model => expect(isOnCooldown('apinex', model, keyId)).toBe(true));
  });

  it.each(['authoritative', 'credit', 'tier'] as const)('preserves an active %s hold on the triggering route too', source => {
    setCooldown('apinex', 'checkin-route', keyId, 60_000, source);
    const before = stored('checkin-route');
    recordRetryableFailure(route(), checkin, newFallbackState());
    expect(stored('checkin-route')).toEqual(before);
    clearApinexCheckinCooldownsForKey(keyId);
    expect(isOnCooldown('apinex', 'checkin-route', keyId)).toBe(true);
    expect(stored('checkin-route')).toEqual(before);
  });

  it.each(['authoritative', 'credit', 'tier'] as const)('allows a new check-in hold after an old %s hold expires', source => {
    vi.useFakeTimers();
    setCooldown('apinex', 'checkin-route', keyId, 1_000, source);
    vi.advanceTimersByTime(1_001);
    setCooldown('apinex', 'checkin-route', keyId, 15 * 60_000, 'checkin');
    expect(getCooldownSource('apinex', 'checkin-route', keyId)).toBe('checkin');
    expect(clearApinexCheckinCooldownsForKey(keyId)).toBe(1);
  });

  it('replaces heuristic holds, stays out of validation probes, and does not touch sibling keys', () => {
    setCooldown('apinex', 'checkin-route', keyId, 60 * 60_000, 'heuristic');
    setCooldown('apinex', 'checkin-route', keyId + 1, 60 * 60_000, 'authoritative');
    setCooldown('apinex', 'checkin-route', keyId, 15 * 60_000, 'checkin');
    expect(getCooldownSource('apinex', 'checkin-route', keyId)).toBe('checkin');
    expect(getProbeableCooldowns().filter(c => c.keyId === keyId)).toEqual([]);
    clearApinexCheckinCooldownsForKey(keyId);
    expect(isOnCooldown('apinex', 'checkin-route', keyId + 1)).toBe(true);
  });

  it('allows a later genuine credit hold to supersede check-in recovery', () => {
    setCooldown('apinex', 'checkin-route', keyId, 15 * 60_000, 'checkin');
    setCooldown('apinex', 'checkin-route', keyId, 60 * 60_000, 'credit');
    expect(clearApinexCheckinCooldownsForKey(keyId)).toBe(0);
    expect(getCooldownSource('apinex', 'checkin-route', keyId)).toBe('credit');
  });

  it('does not modify the in-memory hold when its persisted source is unavailable', () => {
    setCooldown('apinex', 'checkin-route', keyId, 60 * 60_000, 'authoritative');
    const prepare = vi.spyOn(getDb(), 'prepare').mockImplementation(() => { throw new Error('Database unavailable'); });
    setCooldown('apinex', 'checkin-route', keyId, 15 * 60_000, 'checkin');
    expect(clearApinexCheckinCooldownsForKey(keyId)).toBe(0);
    vi.useFakeTimers(); vi.advanceTimersByTime(16 * 60_000);
    expect(isOnCooldown('apinex', 'checkin-route', keyId)).toBe(true);
    prepare.mockRestore();
    expect(getCooldownSource('apinex', 'checkin-route', keyId)).toBe('authoritative');
  });
});
