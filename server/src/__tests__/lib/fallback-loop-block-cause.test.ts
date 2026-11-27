import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  type FallbackHooks,
  type ExhaustionBody,
} from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

let seq = 700;
function fakeRoute(): RouteResult {
  const n = ++seq;
  return {
    provider: {} as any, modelId: 'fake-model', modelDbId: 500000 + n, apiKey: 'k',
    keyId: n, platform: 'fake', displayName: 'Fake Model',
    rpdLimit: null, tpdLimit: null,
  };
}

function hooksSkeleton(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => fakeRoute(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('runFallbackLoop block annotation', () => {
  const cooldownDiag = ['g/x: 1 key(s) — cooldown:1'];
  const routingError = Object.assign(new Error('exhausted'), { status: 429, diagnostics: cooldownDiag });

  it('routing exhaustion without vision gets cause cooldown', async () => {
    let body: ExhaustionBody | undefined;
    await runFallbackLoop(hooksSkeleton({
      route: () => { throw routingError; },
      onRoutingExhausted: (_last, _err, exhaustion) => { body = exhaustion; },
    }));
    expect(body?.status).toBe(429);
    expect(body?.cause).toBe('cooldown');
  });

  it('same exhaustion with requireVision gets vision_quota_exhausted/detail', async () => {
    let body: ExhaustionBody | undefined;
    await runFallbackLoop(hooksSkeleton({
      requireVision: true,
      route: () => { throw routingError; },
      onRoutingExhausted: (_last, _err, exhaustion) => { body = exhaustion; },
    }));
    expect(body?.cause).toBe('vision_quota_exhausted');
    expect(body?.causeDetail).toBe('cooldown');
  });

  it('repeated provider 429 gives cause cooldown (the 429 benched each key)', async () => {
    let body: ExhaustionBody | undefined;
    await runFallbackLoop(hooksSkeleton({
      maxRetries: 2,
      dispatch: async () => { throw new Error('API error 429: rate limit exceeded'); },
      onExhausted: (exhaustion) => { body = exhaustion; },
    }));
    expect(body?.status).toBe(429);
    expect(body?.cause).toBe('cooldown');
  });
});
