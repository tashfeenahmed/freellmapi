import { isClientAbortError, newClientAbortError } from './error-classify.js';

// Stream commit point (M13). Every streaming surface (/v1/chat/completions,
// /v1/completions, /v1/responses, /v1/messages, and inbound-chat behind the
// Gemini and Ollama routes) runs one attempt's stream through the same phases:
//
//   held ──first real payload──▶ committed ──res.end()──▶ finished
//     └────────── client hangs up ──────────▶ abandoned
//
// held      Nothing has reached the client. A failure fails over invisibly.
// committed Headers and payload are out, so the attempt can no longer fail over.
//           A failure is reported in-band, the response is ended, and an
//           'error' row is logged.
// finished  res.end() ran and only bookkeeping is left. A failure there must not
//           write to the response (ERR_STREAM_WRITE_AFTER_END is fatal under the
//           process safety net); the answer was delivered.
// abandoned The client left. The shared fallback loop logs one 'canceled' row,
//           with no bench and no further attempts, whatever phase it left in.
//
// Each surface keeps its own commit flag and wire format. This module owns the
// transitions they all share.
export type StreamPhase = 'held' | 'committed' | 'finished' | 'abandoned';

/** The phase an attempt's stream was in when `err` reached its catch. */
export function failedStreamPhase(err: unknown, res: { writableEnded: boolean }, committed: boolean): StreamPhase {
  if (isClientAbortError(err)) return 'abandoned';
  if (res.writableEnded) return 'finished';
  return committed ? 'committed' : 'held';
}

/** Call right after the pump loop. A client that left while the provider kept
 *  yielding must not reach the success path below the loop: that logged
 *  'success' (and cached the truncated answer on /v1/chat/completions), or,
 *  before the commit point, no row at all. */
export function throwIfAbandoned(clientGone: boolean): void {
  if (clientGone) throw newClientAbortError();
}
