import { describe, it, expect, beforeAll, vi } from 'vitest';

// M19: the non-chat failover loops (embeddings, rerank, moderation, image,
// video, speech, transcription) each re-implemented the same walk with their
// own gaps: no client-abort check, no cooldown on 429, benched keys retried
// first. runFailoverChain is the one walk they all share.

import { initDb } from '../../db/index.js';
import { runFailoverChain, type AttemptOutcome } from '../../lib/failover-chain.js';
import { isOnCooldown, getProbeableCooldowns, setCooldown } from '../../services/ratelimit.js';

class SurfaceError extends Error {
  constructor(message: string, public status: number, public code?: string, public retryAfterMs?: number) {
    super(message);
  }
}

interface Row { platform: string; model: string; keyId: number | null }

let keySeq = 19_000;
const row = (keyId: number | null = ++keySeq): Row => ({ platform: 'groq', model: `m-${keySeq}`, keyId });

function spec(rows: Row[], attempt: (r: Row) => Promise<string>, extra: { signal?: AbortSignal; budgetBlocked?: boolean } = {}) {
  const logged: { model: string; kind: AttemptOutcome<string, SurfaceError>['kind']; status?: number }[] = [];
  const released: number[] = [];
  const skipped: number[] = [];
  const s = {
    rows,
    signal: extra.signal,
    ErrorClass: SurfaceError,
    route: (r: Row) => ({ platform: r.platform, modelId: r.model }),
    reserve: (r: Row, skip: (keyId: number) => boolean) => {
      if (extra.budgetBlocked) return { credential: null, budgetBlocked: true };
      if (r.keyId != null && skip(r.keyId)) { skipped.push(r.keyId); return { credential: null, budgetBlocked: false }; }
      return { credential: { id: r.keyId, release: () => { released.push(r.keyId ?? -1); } }, budgetBlocked: false };
    },
    attempt: (r: Row) => attempt(r),
    log: (r: Row, _keyId: number | null, o: AttemptOutcome<string, SurfaceError>) => {
      logged.push({ model: r.model, kind: o.kind, ...(o.kind === 'error' ? { status: o.error.status } : {}) });
    },
  };
  return { s, logged, released, skipped };
}

beforeAll(() => { initDb(':memory:'); });

describe('runFailoverChain', () => {
  it('fails over to the next row and returns the first success', async () => {
    const [a, b] = [row(), row()];
    const { s, logged, released } = spec([a, b], async r => {
      if (r === a) throw new SurfaceError('boom', 500);
      return 'ok';
    });
    const res = await runFailoverChain(s);
    expect(res).toEqual({ ok: true, row: b, out: 'ok' });
    expect(logged).toEqual([{ model: a.model, kind: 'error', status: 500 }, { model: b.model, kind: 'success' }]);
    expect(released).toEqual([a.keyId, b.keyId]);
  });

  it('wraps a foreign throw as a 502 of the surface error class', async () => {
    const { s } = spec([row()], async () => { throw new TypeError('fetch failed'); });
    const res = await runFailoverChain(s);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.lastError).toBeInstanceOf(SurfaceError);
    expect(res.lastError).toMatchObject({ status: 502, message: 'fetch failed' });
  });

  it('benches a 429 with its Retry-After as authoritative, then skips that key', async () => {
    const a = row();
    const first = spec([a], async () => { throw new SurfaceError('slow down', 429, undefined, 120_000); });
    const res = await runFailoverChain(first.s);
    expect(isOnCooldown(a.platform, a.model, a.keyId!)).toBe(true);
    expect(getProbeableCooldowns().some(c => c.keyId === a.keyId)).toBe(false);
    if (!res.ok) expect(res.hints.retryAfterMs()).toBe(120_000);

    const attempt = vi.fn(async () => 'ok');
    const second = spec([a], attempt);
    const again = await runFailoverChain(second.s);
    expect(attempt).not.toHaveBeenCalled();
    expect(second.skipped).toEqual([a.keyId]);
    // A chain that is only cooling down reports a rate limit, not a dead end.
    expect(again.ok ? null : again.lastError?.status).toBe(429);
  });

  it('a keyless credential is never benched', async () => {
    const a = row(null);
    const { s } = spec([a], async () => { throw new SurfaceError('slow down', 429); });
    await runFailoverChain(s);
    expect(getProbeableCooldowns().some(c => c.modelId === a.model)).toBe(false);
  });

  it('records a monthly-budget block as a 429 quota_exceeded', async () => {
    const { s } = spec([row()], async () => 'ok', { budgetBlocked: true });
    const res = await runFailoverChain(s);
    expect(res.ok ? null : res.lastError).toMatchObject({ status: 429, code: 'quota_exceeded' });
  });

  it('does not start when the client has already gone', async () => {
    const ac = new AbortController();
    ac.abort();
    const attempt = vi.fn(async () => 'ok');
    const { s, logged } = spec([row()], attempt, { signal: ac.signal });
    await expect(runFailoverChain(s)).rejects.toMatchObject({ status: 499 });
    expect(attempt).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('a client that hangs up mid-attempt is logged canceled, not benched, and stops the chain', async () => {
    const ac = new AbortController();
    const [a, b] = [row(), row()];
    const attempt = vi.fn(async (r: Row) => {
      if (r === a) { ac.abort(); throw new SurfaceError('slow down', 429); }
      return 'ok';
    });
    const { s, logged, released } = spec([a, b], attempt, { signal: ac.signal });
    await expect(runFailoverChain(s)).rejects.toMatchObject({ status: 499 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(logged).toEqual([{ model: a.model, kind: 'canceled' }]);
    expect(released).toEqual([a.keyId]);
    expect(isOnCooldown(a.platform, a.model, a.keyId!)).toBe(false);
  });

  it('keeps a real error ahead of a later benched row in the final report', async () => {
    const [a, b] = [row(), row()];
    setCooldown(b.platform, b.model, b.keyId!, 60_000);
    const { s } = spec([a, b], async () => { throw new SurfaceError('bad gateway', 503); });
    const res = await runFailoverChain(s);
    expect(res.ok ? null : res.lastError).toMatchObject({ status: 503 });
  });
});
