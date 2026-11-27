import { AsyncLocalStorage } from 'node:async_hooks';

// Per-attempt upstream stream watch for the fallback loop's silent-window cap
// (#1960). The loop runs each streaming dispatch inside runWithUpstreamWatch;
// the provider layer's real SSE readers (BaseProvider.readSseStream and the
// adapters that parse their own frames) report through currentUpstreamWatch():
//
//  - opened(patienceMs): the upstream answered with a streaming body. The
//    argument is the first-byte patience the adapter declared for this call
//    (its chat timeout, see firstByteBudgetMs). The cap arms only here, so
//    adapters that fake a stream from a blocking call never report opened and
//    are never capped: their silence is a generation in progress, not a stall.
//  - activity(): ANY body bytes arrived: an SSE keep-alive comment, a
//    role-only chunk, a reasoning delta, content. Proof the upstream is alive,
//    so the cap is cancelled for the rest of the attempt (it never applies
//    between tokens).
//
// AsyncLocalStorage rather than an options field: ~40 adapters call
// readSseStream and none of them would need to thread a callback through.
export interface UpstreamStreamWatch {
  opened(patienceMs: number): void;
  activity(): void;
}

const store = new AsyncLocalStorage<UpstreamStreamWatch | undefined>();

export function runWithUpstreamWatch<T>(watch: UpstreamStreamWatch | undefined, fn: () => T): T {
  return store.run(watch, fn);
}

export function currentUpstreamWatch(): UpstreamStreamWatch | undefined {
  return store.getStore();
}
