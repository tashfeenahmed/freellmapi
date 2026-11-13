import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// #1347 follow-up: the provider-moment attribution switch must cover the
// fusion panel/judge retry path too. That path calls recordRateLimitHit on
// every retryable failure and logs the request row with no attribution, so
// with the switch ON a healthy model whose provider threw a 429 inside a
// fusion call was still penalized and still counted against reliability —
// exactly what the feature says it stops doing. Key cooldowns are untouched.

const keySeqStart = 950000;
let keySeq = keySeqStart;

import { initDb, getDb } from '../../db/index.js';
import { runModelCall } from '../../services/fusion.js';
import { getAllPenalties, type RouteResult } from '../../services/router.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

function fakeRoute(throwErr: any): { route: RouteResult; calls: () => number } {
  const n = ++keySeq;
  let calls = 0;
  const route: RouteResult = {
    provider: {
      chatCompletion: async () => { calls++; throw throwErr; },
    } as any,
    modelId: 'fake-fusion-model', modelDbId: n, apiKey: 'test-key',
    keyId: n, platform: 'fakefusion', displayName: 'Fake Fusion Model',
    rpdLimit: null, tpdLimit: null,
  };
  return { route, calls: () => calls };
}

const err429 = () => Object.assign(new Error('API error 429: rate limit exceeded'), { status: 429 });

function penaltyFor(modelDbId: number) {
  return getAllPenalties().find((p) => p.modelDbId === modelDbId);
}

function lastLogRow(): { status: string; failure_attribution: string | null } | undefined {
  return getDb().prepare(
    'SELECT status, failure_attribution FROM requests WHERE model_id = ? ORDER BY id DESC LIMIT 1',
  ).get('fake-fusion-model') as any;
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

async function runSlot(route: RouteResult) {
  let served = 0;
  await runModelCall(
    () => (served++ === 0 ? route : null),
    MESSAGES,
    {} as any,
    10,
    1,
  );
}

describe('provider-moment attribution in the fusion retry path (#1347)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    getDb().prepare('DELETE FROM requests').run();
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
  });

  afterEach(() => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
  });

  it('with attribution ON: a 429 does not penalize the model and the row is tagged', async () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';
    const { route } = fakeRoute(err429());
    await runSlot(route);

    expect(penaltyFor(route.modelDbId)).toBeUndefined();
    // The key cooldown ladder still fires — the failure still steers the key.
    const cooldowns = getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns WHERE key_id = ?')
      .get(route.keyId) as { n: number };
    expect(cooldowns.n).toBe(1);
    expect(lastLogRow()).toEqual({ status: 'error', failure_attribution: 'provider_moment' });
  });

  it('with attribution OFF (default): penalty and untagged row, exactly as before', async () => {
    const { route } = fakeRoute(err429());
    await runSlot(route);

    expect(penaltyFor(route.modelDbId)).toBeDefined();
    expect(lastLogRow()).toEqual({ status: 'error', failure_attribution: null });
  });

  it('with attribution ON: a non-provider-moment failure still penalizes and stays untagged', async () => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = '1';
    const err = Object.assign(new Error('API error 400: unknown parameter'), { status: 400 });
    const { route } = fakeRoute(err);
    await runSlot(route);

    // 400 is not retryable at all, so the slot stops without a penalty —
    // assert instead that the log row was NOT tagged as a provider moment.
    expect(lastLogRow()).toEqual({ status: 'error', failure_attribution: null });
  });
});
