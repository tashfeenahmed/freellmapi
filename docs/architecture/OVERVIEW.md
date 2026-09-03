# Architecture Domain — Overview & File Index

## Scope

This domain holds the implementation deep-dives for FreeLLMAPI's server-side architecture. Each file expands one subsystem with source pointers, scoring formulas, state machines and commit-tagged history. For the high-level summary — what the system is, how a request flows, honest limitations and the provider ToS review — see the high-level index [`architecture.md`](../architecture.md).

## File Index

| File | Scope |
|------|-------|
| [`01-routing-and-bandit-scoring.md`](01-routing-and-bandit-scoring.md) | Thompson-sampling bandit router, reliability posteriors, factor weights (reliability/speed/intelligence/headroom/rate-limit), tunable headroom thresholds (#989), rate-window headroom factor (#899), peak-hours adjustment (#909), least-remaining key selection (#930), 10% explore floor, fallback loop with per-model exhaustion diagnostics, cache key v4 |
| [`02-quota-and-cooldown-engine.md`](02-quota-and-cooldown-engine.md) | RPM/RPD/TPM/TPD accounting, concurrency leases, cooldown ladder (90s → 2m → 10m → 1h → 1d), probe-based early recovery, back-off from error body/header (#798), provider-quota pooling (openrouter::free, google::project), 5s window-utilization snapshot (#899) |
| [`03-streaming-pipeline.md`](03-streaming-pipeline.md) | SSE-only streaming (zero WebSockets), OpenAI chat/completions, Anthropic Messages tool_use block rendering, Gemini `/v1beta`, Responses API shim, error handling mid-stream |
| [`04-degraded-mode-and-failover.md`](04-degraded-mode-and-failover.md) | Degraded-mode state machine (f412e97), hedging/abort on retry budget expiry (1d2226a), X-Fallback-Detail header (8cb75ac), bare safe/unsafe classification failover (a961d93) |
| [`05-catalog-sync.md`](05-catalog-sync.md) | Live signed catalog sync from freellmapi.co, model-age gate (30 days), premium/free tiers, migration seeding vs hosted catalog |
| [`06-observability.md`](06-observability.md) | Observability internals: server-logs ingest path, structured provider logs, boot preload, request analytics, log redaction, attempt tracing, health/routing-trace headers, desktop `freeapi.log` file logger. The operator-facing log viewer and polling API live in [logs/](../logs/01-server-logs-viewer.md). |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain, seeded from architecture-relevant commits |

## How deep-dives fit

The root [`architecture.md`](../architecture.md) stays the high-level index (two-paragraph system summary, request-flow diagram, limitations and ToS). The files above are the deep-dives: start with `01` (bandit scoring & routing) and `02` (quota & cooldown) for the router core, then `03`/`04` for streaming and degraded-mode failover, `05` for catalog sync and `06` for observability internals. The operator-facing logs viewer and polling API are documented separately in [`logs/`](../logs/01-server-logs-viewer.md) and cross-linked from `06`.

## Navigation

- ← [Documentation root](../README.md)
- ↑ [High-level architecture index](../architecture.md)