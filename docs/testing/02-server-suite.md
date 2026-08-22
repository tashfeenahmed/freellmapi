# Server suite

## Layout

All server tests live under [`server/src/__tests__/`](../../server/src/__tests__), mirroring `src/`:

| Directory | Contents |
| --- | --- |
| `db/` | DB init/encryption/hardening, intelligence tiers, node-sqlite behavior, and `db/migrate/` — migration runner tests, registry drift, endpoint identity, and the `roundtrip.test.ts` that `test:migrations` runs in isolation. |
| `lib/` | Pure-module units: error classification, crypto, budget, Gemini wire/schema, fallback loop (incl. client-abort, hedge, lease, model-bench variants), env drift, module purity (see below). |
| `providers/` | Per-adapter tests: google (params/auth-header/schema), openai-compat, cohere, cloudflare, zhipu, aihorde, modelscope, pollinations, cn-providers batch, plus cross-cutting behaviors — abort signals, reasoning timeouts, stream first-byte, stated-retry parsing (#798), max-token caps. |
| `routes/` | HTTP surface tests: proxy/retry/fallback, anthropic messages shim, gemini `/v1beta`, ollama emulation, url-tokens, auth, analytics, custom providers/endpoints, compression/CSP security headers. |
| `services/` | Router/scoring/fusion, health (scheduler, pacing, error/log/transport), cooldown-probe, catalog-sync (scheduler/source), key concurrency, learn-limits, degradation, embeddings/media/transcription. |
| `integration/` | `full-flow.test.ts` — request lifecycle through the assembled app. |
| `helpers/` | Shared test utilities (`auth.ts`, `acl.ts`). |
| `fixtures/` | Golden files (e.g. `compression-golden.json`). |

## Serial forked execution

`npm run test -w server` runs `vitest run --pool=forks --fileParallelism=false`. Two deliberate choices:

- **`--pool=forks`** isolates each test file in a fresh process. The suite manipulates real state — better-sqlite3 databases, `process.env`, module-level caches (cooldown maps, health schedulers) — that must not leak between files.
- **`--fileParallelism=false`** serializes files so shared resources (ports, temp data dirs) cannot collide across concurrently executing files.

The tradeoff is wall-clock time; the payoff is that the ~2300-test suite is deterministic. The client workspace does not need this: its [standalone vitest config](../../client/vitest.config.ts) exists mainly to avoid loading the React/Tailwind vite plugins, and its tests are plain TypeScript in the default node environment.

## Pure-lib import guard (#858)

[`src/__tests__/lib/module-purity.test.ts`](../../server/src/__tests__/lib/module-purity.test.ts) enforces an architectural invariant: modules declared pure in [`server/src/lib/`](../../server/src/lib/) (functions over their arguments — no I/O, no DB, no config) must stay free of **value** imports. `import type` stays legal because type imports are erased before they can create a cycle.

Why it exists: pure leaf modules like `error-classify.ts` are imported by the proxy chat path, the responses path, AND the fusion panel precisely because they depend on nothing. One added `import { getDb }` compiles cleanly, passes every behavioral test, and quietly turns a leaf into a hub — surfacing later as an import cycle (the fusion↔proxy case) or a unit test that suddenly needs a database. The guard also detects dynamic imports, re-exports, and `require()`.

The list maintains itself: any new import-free lib module fails the suite until it is classified as guarded or deliberately not — a decision made out loud in a diff rather than by omission.

## Loopback binding convention (#888)

Every route/integration test starts its server as:

```ts
const server = app.listen(0, '127.0.0.1');
if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
```

Two details, both load-bearing (#888):

1. **Bind to `127.0.0.1` explicitly.** The older `app.listen(0)` bound the IPv6 wildcard `::`, while tests fetched `http://127.0.0.1:PORT` over IPv4. Different addresses means an unrelated local process holding an IPv4 listener on the same ephemeral port wins the connection without triggering `EADDRINUSE` — requests were answered by that process (observed with `wrangler dev` workerd processes replying 404/501), producing random assertion failures, broken JSON parses, and 5s timeouts roughly every second-to-fourth run.
2. **Wait for the `listening` event before reading `address()`.** `listen(port, host)` resolves the host asynchronously (unlike `listen(port)`), so `server.address().port` is only reliable after the event fires.

Verified fix: ten consecutive full suite runs clean against a machine with the colliding processes still running.
