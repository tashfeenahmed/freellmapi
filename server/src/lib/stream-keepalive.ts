// SSE keep-alive pings for the uncommitted streaming window (#1642).
//
// The streaming routes hold every byte — headers included — until the first
// real text token, so a reasoning model can leave the wire silent for 30-180s
// while it thinks. Clients with a time-to-first-byte watchdog (Claude Code's
// stream-idle timeout is the reference case) abort during that window, the
// router logs "client disconnected mid-attempt", and the user reruns the turn.
//
// When STREAM_KEEPALIVE_MS is set, each streaming pump starts an interval
// that emits a content-free keep-alive frame while the attempt is in flight.
// On the OpenAI surfaces that is a bare SSE comment line (`: keepalive`),
// which every spec-compliant parser ignores; on the Anthropic surface it is
// the protocol's own `ping` event.
//
// The invariant this preserves: the ping carries NO content, so nothing the
// client can act on has been sent. What it necessarily gives up when enabled
// is invisible failover FOR THAT ATTEMPT — a ping flushes the SSE headers, so
// a stream that then dies ends the response with an error frame instead of
// retrying another provider behind the scenes. That trade is exactly what an
// operator opts into; the default is OFF, keeping the current behavior for
// everyone who has not heard of the problem.
//
// Pings keep firing on a committed-but-silent stream too (upstream stalled
// mid-reasoning), which is also useful: an idle upstream no longer looks
// different from an idle connection at the client either way, but the extra
// bytes stop the client from killing a stream that is merely slow.
const MIN_KEEPALIVE_MS = 1000;

/**
 * The keep-alive interval in ms, parsed from STREAM_KEEPALIVE_MS.
 * Unset / empty / 0 / non-numeric / negative → 0 (feature off, default).
 * Positive values are clamped to a 1s floor: a sub-second ping interval just
 * burns bandwidth and adds SSE frames no client asked for.
 */
export function streamKeepaliveMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STREAM_KEEPALIVE_MS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(MIN_KEEPALIVE_MS, Math.floor(n));
}

/**
 * Start the keep-alive interval for one stream attempt.
 *
 * - `intervalMs` ≤ 0 disables the feature: no timer is created and the
 *   returned stop function is a no-op.
 * - `isDone` is polled at every tick: once the attempt has finished (response
 *   ended, failed over, or errored), the timer stops itself.
 * - `keepalive` runs on each tick and must write a content-free frame. It is
 *   expected to commit the response first if it has not been committed yet.
 *   Throwing (dead socket) stops the timer without surfacing anything —
 *   the pump's own error paths notice the broken connection.
 *
 * Returns the stop function; call it when the stream ends. Idempotent.
 */
export function startStreamKeepalive(
  intervalMs: number,
  isDone: () => boolean,
  keepalive: () => void,
): () => void {
  if (intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    if (isDone()) { stop(); return; }
    try {
      keepalive();
    } catch {
      stop();
    }
  }, intervalMs);
  // Never hold the process open for a ping that outlived its request.
  if (typeof timer.unref === 'function') timer.unref();
  function stop(): void {
    clearInterval(timer);
  }
  return stop;
}
