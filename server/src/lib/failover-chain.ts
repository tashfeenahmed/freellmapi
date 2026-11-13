import { RetryHintTracker } from './retry-hint.js';
import { getActiveCooldownsForKeys, isOnCooldown, setRetryAfterCooldown } from '../services/ratelimit.js';
import { secondsUntilNextMonth } from '../services/key-budget.js';

// The failover walk shared by the non-chat surfaces (M19): embeddings, rerank,
// moderation, image, video, speech and transcription. Chat has its own, richer
// loop (lib/fallback-loop.ts). Per row:
//
//   client gone? ─▶ throw (no attempt)
//   reserve a credential, skipping keys benched for this (platform, model)
//     none ─▶ note why (budget / cooling down) and try the next row
//   attempt ─▶ success: log, return
//           └▶ failure: client gone ─▶ log 'canceled', throw (no bench, no next row)
//                       else         ─▶ log 'error', bench a 429, try the next row
//
// The surface keeps its own adapters, wire format, log table and final error.

/** What a surface's error class must carry for failover bookkeeping. */
export interface ChainError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

/** A reserved credential. `id` is null for a keyless provider (never benched). */
export interface ChainCredential {
  id: number | null;
  release?: () => void;
}

export type AttemptOutcome<Out, E> =
  | { kind: 'success'; out: Out; latencyMs: number }
  | { kind: 'error'; error: E; latencyMs: number }
  | { kind: 'canceled'; latencyMs: number };

export interface FailoverChainSpec<Row, Cred extends ChainCredential, Out, E extends ChainError> {
  rows: readonly Row[];
  /** The API caller's connection; aborted means the client hung up. */
  signal?: AbortSignal;
  ErrorClass: new (message: string, status: number, code?: string, retryAfterMs?: number) => E;
  /** The (platform, model) a 429 benches and a benched key is skipped for. */
  route(row: Row): { platform: string; modelId: string };
  /** `cooldownBlocked`: the reserve itself skipped keys benched for this row
   *  (a custom endpoint's key pool), with the soonest expiry when known. */
  reserve(row: Row, skip: (keyId: number) => boolean): {
    credential: Cred | null;
    budgetBlocked: boolean;
    cooldownBlocked?: boolean;
    cooldownRetryAfterMs?: number;
  };
  attempt(row: Row, credential: Cred): Promise<Out>;
  /** After a failed attempt: try another key of the SAME row before moving on
   *  (a custom endpoint pools several keys). Keys already tried are skipped. */
  retrySameRow?(row: Row, error: E): boolean;
  log(row: Row, keyId: number | null, outcome: AttemptOutcome<Out, E>): void;
}

export type FailoverChainResult<Row, Out, E> =
  | { ok: true; row: Row; out: Out }
  | { ok: false; lastError: E | null; hints: RetryHintTracker };

export async function runFailoverChain<Row, Cred extends ChainCredential, Out, E extends ChainError>(
  spec: FailoverChainSpec<Row, Cred, Out, E>,
): Promise<FailoverChainResult<Row, Out, E>> {
  const { ErrorClass, signal } = spec;
  const clientGone = () => new ErrorClass('client closed the request', 499);
  let lastError: E | null = null;
  // Only a chain rate limited end to end earns a Retry-After (the soonest).
  const hints = new RetryHintTracker();

  for (const row of spec.rows) {
    const { platform, modelId } = spec.route(row);
    // Keys of this row already attempted (only grows when retrySameRow says so).
    const tried = new Set<number>();
    for (;;) {
      if (signal?.aborted) throw clientGone();
      const benched: number[] = [];
      const { credential, budgetBlocked, cooldownBlocked, cooldownRetryAfterMs } = spec.reserve(row, keyId => {
        if (tried.has(keyId)) return true;
        const onCooldown = isOnCooldown(platform, modelId, keyId);
        if (onCooldown) benched.push(keyId);
        return onCooldown;
      });
      if (!credential) {
        if (budgetBlocked) {
          lastError = new ErrorClass('Monthly key budget exhausted', 429, 'quota_exceeded');
          hints.record(429, secondsUntilNextMonth() * 1000);
        }
        if (cooldownBlocked || benched.length > 0) {
          // A real upstream error from an earlier row says more than this.
          lastError ??= cooldownBlocked
            ? new ErrorClass('Provider keys are cooling down', 429)
            : new ErrorClass(`every ${platform} key is cooling down after a rate limit`, 429);
          hints.record(429, soonest(cooldownRetryAfterMs, soonestBenchMs(platform, modelId, benched)));
        }
        break;
      }
      if (credential.id != null) tried.add(credential.id);

      const started = Date.now();
      try {
        const out = await spec.attempt(row, credential);
        spec.log(row, credential.id, { kind: 'success', out, latencyMs: Date.now() - started });
        return { ok: true, row, out };
      } catch (err: any) {
        const latencyMs = Date.now() - started;
        // Whatever the attempt died of, nobody is waiting for the answer: no
        // bench, and no second upstream call charged for it.
        if (signal?.aborted) {
          spec.log(row, credential.id, { kind: 'canceled', latencyMs });
          throw clientGone();
        }
        const e = err instanceof ErrorClass ? err : new ErrorClass(String(err?.message ?? err), 502);
        spec.log(row, credential.id, { kind: 'error', error: e, latencyMs });
        if (e.status === 429 && credential.id != null) setRetryAfterCooldown(platform, modelId, credential.id, e.retryAfterMs);
        lastError = e;
        hints.record(e.status, e.retryAfterMs);
        if (credential.id == null || !spec.retrySameRow?.(row, e)) break;
      } finally {
        credential.release?.();
      }
    }
  }
  return { ok: false, lastError, hints };
}

function soonest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/** Time left on the soonest of these keys' benches for (platform, model). */
function soonestBenchMs(platform: string, modelId: string, keyIds: number[]): number | undefined {
  let min: number | undefined;
  for (const list of getActiveCooldownsForKeys(keyIds).values()) {
    for (const c of list) {
      if (c.platform === platform && c.modelId === modelId) min = soonest(min, c.remainingMs);
    }
  }
  return min;
}
