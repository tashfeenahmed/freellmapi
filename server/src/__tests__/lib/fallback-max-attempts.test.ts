import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// FALLBACK_MAX_ATTEMPTS: one validated cap on failover hops, shared by every
// chat surface. An invalid value must never remove the cap.

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({ checkKeyHealth: mockCheckKeyHealth, markKeyHealthyFromRequest: vi.fn() }));

import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop, newFallbackState, getFallbackMaxAttempts, parseFallbackMaxAttempts,
  DEFAULT_FALLBACK_MAX_ATTEMPTS, FALLBACK_MAX_ATTEMPTS_MAX, type FallbackHooks,
} from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 7300;
function fakeRoute(): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: `fake-model-${n}`, modelDbId: 731000 + n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model', rpdLimit: null, tpdLimit: null,
  };
}

function hooks(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0, // budget off: only the attempt cap can stop the loop
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

const alwaysUpstream502 = () => vi.fn(async () => { throw Object.assign(new Error('Bad Gateway'), { status: 502 }); });

const saved = process.env.FALLBACK_MAX_ATTEMPTS;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});
beforeEach(() => {
  delete process.env.FALLBACK_MAX_ATTEMPTS;
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
});
afterEach(() => {
  if (saved === undefined) delete process.env.FALLBACK_MAX_ATTEMPTS;
  else process.env.FALLBACK_MAX_ATTEMPTS = saved;
});

describe('parseFallbackMaxAttempts', () => {
  it('defaults to 20 when unset or blank', () => {
    expect(DEFAULT_FALLBACK_MAX_ATTEMPTS).toBe(20);
    expect(parseFallbackMaxAttempts(undefined)).toEqual({ value: 20, valid: true });
    expect(parseFallbackMaxAttempts('  ')).toEqual({ value: 20, valid: true });
  });

  it('accepts integers from 1 to 100', () => {
    expect(parseFallbackMaxAttempts('1')).toEqual({ value: 1, valid: true });
    expect(parseFallbackMaxAttempts(' 7 ')).toEqual({ value: 7, valid: true });
    expect(parseFallbackMaxAttempts(String(FALLBACK_MAX_ATTEMPTS_MAX))).toEqual({ value: 100, valid: true });
  });

  it.each(['0', '-3', '101', '1e3', '2.5', 'abc', 'Infinity', '0x10', '99999999999999999999'])(
    'rejects %s and keeps the default cap', (raw) => {
      expect(parseFallbackMaxAttempts(raw)).toEqual({ value: 20, valid: false });
    },
  );
});

describe('getFallbackMaxAttempts', () => {
  it('reads FALLBACK_MAX_ATTEMPTS and warns once per invalid value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FALLBACK_MAX_ATTEMPTS = '4';
    expect(getFallbackMaxAttempts()).toBe(4);
    process.env.FALLBACK_MAX_ATTEMPTS = 'lots';
    expect(getFallbackMaxAttempts()).toBe(20);
    expect(getFallbackMaxAttempts()).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('lots'); // never echoes config values
    warn.mockRestore();
  });
});

describe('the loop honours the cap', () => {
  it('stops after FALLBACK_MAX_ATTEMPTS attempts when every attempt fails', async () => {
    process.env.FALLBACK_MAX_ATTEMPTS = '3';
    const dispatch = alwaysUpstream502();
    const onExhausted = vi.fn();
    await runFallbackLoop(hooks({ dispatch, onExhausted }));
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('falls back to 20 attempts, not unlimited, when the value is invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FALLBACK_MAX_ATTEMPTS = '-1';
    const dispatch = alwaysUpstream502();
    await runFallbackLoop(hooks({ dispatch }));
    expect(dispatch).toHaveBeenCalledTimes(20);
    warn.mockRestore();
  });

  it('a surface-provided maxRetries still wins', async () => {
    process.env.FALLBACK_MAX_ATTEMPTS = '9';
    const dispatch = alwaysUpstream502();
    await runFallbackLoop(hooks({ dispatch, maxRetries: 2 }));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('every chat surface uses the shared setting', () => {
  const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../routes');
  it.each(['proxy.ts', 'anthropic.ts', 'responses.ts'])('%s has no hard-coded retry cap', (file) => {
    const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
    expect(src).not.toMatch(/MAX_RETRIES\s*=/);
    expect(src).not.toMatch(/maxRetries:\s*\d/);
    expect(src).toMatch(/maxRetries: getFallbackMaxAttempts\(\)/);
  });
});
