// Per-request attempt trace: the durable record of the failover ladder one
// proxied request walked (groq 429 → google timeout → cerebras ok). The
// fallback loop collects one AttemptTraceRecord per dispatched attempt —
// including the SUCCESSFUL final one — and request-log.ts persists the batch
// into `request_attempts`, keyed to the terminal `requests` row.
//
// The trace travels on AsyncLocalStorage (same pattern as client-context.ts)
// so logRequest() can report back the id of each `requests` row it writes
// without threading a parameter through every surface's dispatch closure.
// The LAST id noted during a loop run is the terminal row — the success row,
// a committed mid-stream error row, or the final per-attempt failure row —
// and that is the row the batch is keyed to. Calls to logRequest outside a
// fallback-loop run (fusion sub-calls, embeddings, media) see no trace and
// are unaffected.

import { AsyncLocalStorage } from 'async_hooks';
import type { AttemptErrorClass } from './fallback-loop.js';

// 'ok'           — the attempt produced the client's response ('done').
// 'committed'    — a stream flushed real bytes, then ended without a clean
//                  finish (mid-stream error the surface rendered honestly, or
//                  a pre-commit client disconnect the surface swallowed); the
//                  parent requests row carries the specifics.
// 'client_abort' — the client hung up mid-attempt; the upstream call was
//                  canceled and no failure bookkeeping ran.
// AttemptErrorClass — the failure class of a failed-and-failed-over attempt.
export type AttemptOutcome = 'ok' | 'committed' | 'client_abort' | AttemptErrorClass;

export interface AttemptTraceRecord {
  // 0-based position in the ladder; the persistence order key.
  ordinal: number;
  platform: string;
  modelId: string;
  // Per-request key ordinal (key1, key2…), same anonymization as the
  // X-Fallback-Trail header — never the internal key id.
  keyOrdinal: number;
  // Operator-facing key label (api_keys.label) at attempt time (#869). Null
  // when the key had no label — the dashboard shows the ordinal alone then.
  // A snapshot, not a live join: renaming the key later must not rewrite
  // history. Deliberately NOT the internal key id or the key itself.
  keyLabel: string | null;
  outcome: AttemptOutcome;
  // Milliseconds from the ladder's start to this attempt's dispatch.
  startOffsetMs: number;
  // Milliseconds this attempt ran (for 'ok' streams: until the response
  // finished, i.e. including streaming time).
  durationMs: number;
  // Short, REDACTED summary of the error that ended this attempt (see
  // lib/error-redaction.ts summarizeAttemptError — secrets scrubbed, capped at
  // 200 chars). Null for successful hops ('ok'/'committed').
  errorSummary: string | null;
}

export interface RequestTrace {
  records: AttemptTraceRecord[];
  // Rowid of the most recent `requests` row logged during this trace's run;
  // null until the first logRequest lands (e.g. a client abort on attempt 1).
  lastRequestRowId: number | null;
}

const storage = new AsyncLocalStorage<RequestTrace>();

export function newRequestTrace(): RequestTrace {
  return { records: [], lastRequestRowId: null };
}

export function runWithRequestTrace<T>(trace: RequestTrace, fn: () => T): T {
  return storage.run(trace, fn);
}

export function getRequestTrace(): RequestTrace | undefined {
  return storage.getStore();
}

/** Called by logRequest() after inserting a `requests` row; no-op outside a trace. */
export function noteRequestRowId(id: number | bigint): void {
  const trace = storage.getStore();
  if (trace) trace.lastRequestRowId = Number(id);
}
