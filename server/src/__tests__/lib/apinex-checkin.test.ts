import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  isApinexCheckinRequired, cooldownDecisionForError, recordRetryableFailure, newFallbackState,
  exhaustedRetryError, routingExhaustionBody,
} from '../../lib/fallback-loop.js';
import { setCooldown, getCooldownSource, clearCooldownsForKey } from '../../services/ratelimit.js';
import { getAllPenalties, type RouteResult } from '../../services/router.js';

const checkin = Object.assign(
  new Error('APINex API error 402: Daily check-in required to use free models.'),
  { status: 402 },
);
const generic402 = Object.assign(new Error('APINex API error 402: Insufficient credits'), { status: 402 });
const route = (platform = 'apinex'): RouteResult => ({
  provider: {} as any, platform, modelId: 'free/gemini-3.8-flash',
  modelDbId: 760100, keyId: 760100, apiKey: 'test', keyLabel: null,
  displayName: 'Test', contextWindow: null, endpointScope: '', rpdLimit: null, tpdLimit: null,
});

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('APINex daily website check-in recovery', () => {
  it('recognizes only APINex daily check-in HTTP 402', () => {
    expect(isApinexCheckinRequired('apinex', checkin)).toBe(true);
    expect(isApinexCheckinRequired('apinex', generic402)).toBe(false);
    expect(isApinexCheckinRequired('openrouter', checkin)).toBe(false);
    expect(isApinexCheckinRequired('apinex', { ...checkin, status: 429 })).toBe(false);
  });

  it('uses a persisted, time-bounded checkin cooldown rather than 24h credit bench', () => {
    const result = cooldownDecisionForError(route(), checkin);
    expect(result).toEqual({ durationMs: 15 * 60_000, source: 'checkin' });
    expect(cooldownDecisionForError(route(), generic402).source).toBe('credit');
    expect(cooldownDecisionForError(route('openrouter'), checkin).source).toBe('credit');
    setCooldown('apinex', route().modelId, route().keyId, result.durationMs, result.source);
    expect(getCooldownSource('apinex', route().modelId, route().keyId)).toBe('checkin');
    clearCooldownsForKey(route().keyId);
    expect(getCooldownSource('apinex', route().modelId, route().keyId)).toBeNull();
  });

  it('does not demote the model for an account-level website visit requirement', () => {
    recordRetryableFailure(route(), checkin, newFallbackState());
    expect(getAllPenalties().find(p => p.modelDbId === route().modelDbId)).toBeUndefined();
    clearCooldownsForKey(route().keyId);
  });

  it('provides an actionable OpenAI error after an APINex-only rejected attempt', () => {
    const result = exhaustedRetryError(checkin, 1, {
      attempts: [{ platform: 'apinex', modelId: route().modelId, keyOrdinal: 1, errorClass: 'out_of_credits' }],
    });
    expect(result.code).toBe('provider_checkin_required');
    expect(result.message).toContain('https://apinex.bond/');
    expect(result.status).toBe(429);
  });

  it('keeps the check-in explanation after the model was benched (zero upstream attempts)', () => {
    const result = routingExhaustionBody({
      message: 'All models exhausted',
      diagnostics: ['apinex/free/gemini-3.8-flash: 1 key(s) — checkin-required:1'],
    });
    expect(result.code).toBe('provider_checkin_required');
    expect(result.message).toContain('https://apinex.bond/');
    expect(routingExhaustionBody({
      message: 'All models exhausted',
      diagnostics: [
        'apinex/free/gemini-3.8-flash: 1 key(s) — checkin-required:1',
        'nvidia/nemotron: 1 key(s) — cooldown:1',
      ],
    }).code).not.toBe('provider_checkin_required');
  });
});
