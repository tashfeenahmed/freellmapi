import { describe, it, expect } from 'vitest';
import { baseBlockCause, blockCause } from '../../lib/block-cause.js';
import { exhaustionErrorPayload, setExhaustionHeaders } from '../../lib/fallback-loop.js';
import type { AttemptRecord, AttemptErrorClass, ExhaustionBody } from '../../lib/fallback-loop.js';

function attempt(errorClass: AttemptErrorClass): AttemptRecord {
  return { platform: 'g', modelId: 'x', keyOrdinal: 1, errorClass };
}

describe('baseBlockCause', () => {
  it('cooldown family', () => {
    expect(baseBlockCause(['g/x: 1 key(s) — cooldown:1'], [])).toBe('cooldown');
  });

  it('every provider-limit reason', () => {
    for (const reason of ['provider-daily-cap', 'provider-minute-cap', 'provider-daily-token-cap', 'cloudflare-neuron-cap', 'checkin-required']) {
      expect(baseBlockCause([`g/x: 1 key(s) — ${reason}:1`], [])).toBe('provider_limit');
    }
  });

  it('every key-quota reason', () => {
    for (const reason of ['rpm/rpd-limit', 'tpm/tpd-limit', 'monthly-budget-cap', 'key-concurrency']) {
      expect(baseBlockCause([`g/x: 1 key(s) — ${reason}:1`], [])).toBe('key_quota');
    }
  });

  it('two different families give chain_exhausted', () => {
    expect(baseBlockCause(['g/x: 1 key(s) — cooldown:1', 'g/y: 1 key(s) — rpm/rpd-limit:1'], [])).toBe('chain_exhausted');
  });

  it('ignored reasons and ruled-out lines do not mix families', () => {
    expect(baseBlockCause([
      'g/x: 1 key(s) — cooldown:1, already-failed-this-request:1',
      'g/y ruled out earlier this request',
    ], [])).toBe('cooldown');
  });

  it('config-only lines give chain_exhausted', () => {
    expect(baseBlockCause([
      'g/x: no enabled+healthy key for platform',
      '5 model(s) skipped: no enabled+healthy key for platform (g, c)',
    ], [])).toBe('chain_exhausted');
  });

  it('an unknown non-ignored line mixes families', () => {
    expect(baseBlockCause(['m: no tool-calling support', 'g/x: 1 key(s) — cooldown:1'], [])).toBe('chain_exhausted');
  });

  it('attempt error classes', () => {
    expect(baseBlockCause([], [attempt('rate_limited'), attempt('rate_limited')])).toBe('cooldown');
    expect(baseBlockCause([], [attempt('daily_quota_exhausted'), attempt('out_of_credits')])).toBe('key_quota');
    expect(baseBlockCause([], [attempt('rate_limited'), attempt('timeout')])).toBe('chain_exhausted');
  });

  it('a key that 429d this request plus siblings already cooling reads as cooldown, not chain_exhausted', () => {
    // The 429 benched key 1 (cooldown); the router then saw it as already
    // failed and key 2 as cooling. Same state as the next request's pure
    // cooldown line, so the same cause.
    expect(baseBlockCause(['g/x: 2 key(s) — already-failed-this-request:1, cooldown:1'], [attempt('rate_limited')])).toBe('cooldown');
    expect(baseBlockCause(['g/x: 1 key(s) — cooldown:1'], [])).toBe('cooldown');
  });

  it('cooling keys mixed with a monthly-capped key stay chain_exhausted (two different causes)', () => {
    expect(baseBlockCause([
      'g/x: 1 key(s) — cooldown:1',
      'g/y: 1 key(s) — monthly-budget-cap:1',
    ], [])).toBe('chain_exhausted');
    expect(baseBlockCause(['g/x: 2 key(s) — cooldown:1, monthly-budget-cap:1'], [])).toBe('chain_exhausted');
  });

  it('baseBlockCause with vision line and cooldown gives chain_exhausted (base treats vision as filter)', () => {
    expect(baseBlockCause(['g/x: 1 key(s) — cooldown:1', 'c/a: no vision support'], [])).toBe('chain_exhausted');
  });

  it('mixed key tokens — cooldown counted, custom-key-mismatch ignored, mixed with other gives chain_exhausted', () => {
    // All tokens ignored in first line → config only → chain_exhausted
    expect(baseBlockCause(['g/x: 2 key(s) — cooldown:1, decrypt-error:1', 'g/y: 1 key(s) — cooldown:1'], [])).toBe('cooldown');
    // Mixed families: cooldown from mixed line + key_quota from other line → chain_exhausted
    expect(baseBlockCause(['g/x: 2 key(s) — cooldown:1, custom-key-mismatch:1', 'g/y: 1 key(s) — rpm/rpd-limit:1'], [])).toBe('chain_exhausted');
  });
});

describe('blockCause', () => {
  const cooldownVisionDiag = [
    'g/v1: 1 key(s) — cooldown:1',
    'g/v2: 1 key(s) — cooldown:1',
    'g/v3: 1 key(s) — cooldown:1',
    'g/v4: 1 key(s) — cooldown:1',
    'g/v5: 1 key(s) — cooldown:1',
    'c/a: no vision support',
    'c/b: no vision support',
  ];

  it('non-429 statuses have no block cause', () => {
    for (const status of [502, 503, 413, 400]) {
      expect(blockCause({ status, requireVision: true, diag: [], attempts: [] })).toBeUndefined();
    }
  });


  it('vision with cooldown diag gives vision_quota_exhausted/detail cooldown', () => {
    expect(blockCause({ status: 429, requireVision: true, diag: cooldownVisionDiag, attempts: [] }))
      .toEqual({ cause: 'vision_quota_exhausted', detail: 'cooldown' });
  });

  it('vision with rate_limited attempts and no diag', () => {
    expect(blockCause({ status: 429, requireVision: true, attempts: [attempt('rate_limited')] }))
      .toEqual({ cause: 'vision_quota_exhausted', detail: 'cooldown' });
  });

  it('no vision flag means no vision cause even with no-vision diag', () => {
    expect(blockCause({ status: 429, requireVision: false, diag: cooldownVisionDiag, attempts: [] }))
      .toEqual({ cause: 'chain_exhausted' });
  });

  it('baseBlockCause with vision line and cooldown gives chain_exhausted (2 params only)', () => {
    expect(baseBlockCause(['g/x: 1 key(s) — cooldown:1', 'c/a: no vision support'], [])).toBe('chain_exhausted');
  });

  it('blockCause requireVision, no attempts, mixed cooldown/decrypt-error line gives vision_quota_exhausted/detail cooldown', () => {
    expect(blockCause({ status: 429, requireVision: true, diag: ['c/a: no vision support', 'g/x: 2 key(s) — cooldown:1, decrypt-error:1'], attempts: [] })).toEqual({ cause: 'vision_quota_exhausted', detail: 'cooldown' });
    expect(blockCause({ status: 429, requireVision: true, diag: ['c/a: no vision support', 'g/x: 2 key(s) — rpm/rpd-limit:1, no-resolved-provider:1', 'g/y: 1 key(s) — no usable key'], attempts: [] })).toEqual({ cause: 'vision_quota_exhausted', detail: 'key_quota' });
  });


});

describe('exhaustion payload and headers', () => {
  const base: ExhaustionBody = {
    status: 429, type: 'rate_limit_error', kind: 'rate_limit', message: 'exhausted', code: 'routing_exhausted',
  };

  it('cause is emitted only when present, detail only when present', () => {
    expect(exhaustionErrorPayload({ ...base, cause: 'cooldown' })).toEqual({
      message: 'exhausted', type: 'rate_limit_error', code: 'routing_exhausted', cause: 'cooldown',
    });
    expect(exhaustionErrorPayload({ ...base, cause: 'vision_quota_exhausted', causeDetail: 'cooldown' })).toEqual({
      message: 'exhausted', type: 'rate_limit_error', code: 'routing_exhausted',
      cause: 'vision_quota_exhausted', cause_detail: 'cooldown',
    });
    expect(exhaustionErrorPayload(base)).toEqual({
      message: 'exhausted', type: 'rate_limit_error', code: 'routing_exhausted',
    });
  });

  it('block headers are set before the Retry-After early return', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => { headers[name] = value; } };
    setExhaustionHeaders(res, { ...base, cause: 'vision_quota_exhausted', causeDetail: 'cooldown' });
    expect(headers['X-Block-Cause']).toBe('vision_quota_exhausted');
    expect(headers['X-Block-Cause-Detail']).toBe('cooldown');
    expect(headers['Retry-After']).toBeUndefined();
  });
});
