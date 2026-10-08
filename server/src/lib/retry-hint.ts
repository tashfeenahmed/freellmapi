// Aggregate the upstream back-off hints seen while a service walks its provider
// chain (embeddings, media) into the one Retry-After the gateway may honestly
// send once the chain is dry.
//
// Mirrors the chat exhaustion rule (lib/fallback-loop.ts exhaustedRetryError):
// a Retry-After is only a promise when EVERY attempted candidate was rate
// limited, and then it is the SOONEST moment any of them comes back — never the
// last provider's value. A single 429 whose sibling then 500s, or a 429 that
// stated no delay, means we cannot tell the client when to return, so no hint.

/** One chain walk's view of the upstream back-offs. */
export class RetryHintTracker {
  private minMs: number | undefined;
  private unknown = false;
  private attempts = 0;

  /** Record one failed candidate. `retryAfterMs` is the stated back-off, if any. */
  record(status: number, retryAfterMs: number | undefined): void {
    this.attempts++;
    if (status !== 429 || retryAfterMs === undefined) {
      this.unknown = true;
      return;
    }
    this.minMs = this.minMs === undefined ? retryAfterMs : Math.min(this.minMs, retryAfterMs);
  }

  /** The soonest stated back-off when every recorded failure was a 429 carrying
   *  one; undefined otherwise (including when nothing was recorded). */
  retryAfterMs(): number | undefined {
    if (this.attempts === 0 || this.unknown) return undefined;
    return this.minMs;
  }
}

/** Milliseconds → whole Retry-After seconds (ceil, at least 1). */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}
