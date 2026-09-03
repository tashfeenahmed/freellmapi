# Prompt compression

[← Back to README](../README.md) · [Documentation index](../README.md) · [API reference](../api/01-rest-api.md)

Long coding-agent sessions repeatedly send system prompts, file reads, command output, and tool schemas. FreeLLMAPI can shrink that request context before cache lookup, token budgeting, and routing, so the router sees the reduced estimate and more small-context models remain eligible. Provider responses are never rewritten.

The same pipeline runs on Chat Completions, Responses, Anthropic Messages, and Anthropic token counting. Compression is **off by default**.

## Enable it

Choose a mode under dashboard **Settings → Prompt compression**, or bootstrap the mode with:

```env
FREELLMAPI_COMPRESSION=lossless
```

Once settings have been saved in the dashboard, the stored setting takes precedence over the environment value.

| Mode | What runs |
| --- | --- |
| `off` | No request rewriting. This is a master switch; a request header cannot enable it. |
| `lossless` | Repeated-block deduplication, whitespace hygiene, and reversible homogeneous-JSON table encoding. |
| `standard` | Lossless engines plus command-aware tool-output filtering and stale file-read supersession. |
| `aggressive` | Standard engines plus older-turn condensation, lexical relevance filtering, and an optional hard token target. |

The dashboard also controls each engine independently, the estimated-token auto-trigger, target size, stable-prefix freezing, and whether repository-local filters are trusted.

## Per-request control

Send one of these values with `X-FreeLLM-Compress`:

```text
off | on | lossless | standard | aggressive
```

The header may turn compression off or lower the operator's configured mode, but it cannot raise it. `on` uses the configured mode. Responses report the effective mode and estimated savings:

```text
X-FreeLLM-Compress: standard; saved~=1840
```

Savings use the same estimated `chars / 4` accounting as routing, so the header deliberately uses `~=`.

## Adaptive compression

When `autoTriggerEstTokens` is configured and an uncompressed request crosses that estimate, the pipeline may use aggressive engines even if the normal configured mode is lower. It stops once `targetTokens` is reached. An explicit request header still wins when it lowers the permitted mode.

## Fidelity and cache safety

The pipeline is fail-open. Every engine runs independently, and its output is discarded if it grows the request, throws an exception, or fails a fidelity gate. The gate requires:

> **Perf note (cf0c216):** The protected-span check now early-exits when a span is
> already known to be preserved, avoiding redundant work in the per-line hot path.

- all distinct numeric literals and diff hunks to survive;

- all distinct numeric literals and diff hunks to survive;
- every explicit constraint, security instruction, and error line to survive;
- at least 90% of JSON keys to survive;
- at least 95% of other protected spans to survive;
- tool-call and tool-result envelopes to remain valid.

Protected spans include code fences, URLs, file paths, stack traces, explicit constraints, error lines, key/value pairs, and structured tool metadata.

Repeated stable system prefixes are frozen after their third appearance. Anthropic `cache_control` prefixes are capped at lossless rewriting. Compression configuration is included in the response-cache fingerprint, so differently compressed requests cannot share a stale cache entry.

## Tool-output filters

Built-in filters understand common output from Git, package managers, test runners, builds, Docker, search tools, JSON, and stack traces. They can remove ANSI escape sequences, collapse repetitive sections, keep matched lines, and preserve useful head/tail context under character and line limits. Error output receives conservative treatment.

Additional JSON filter definitions can be loaded from:

- `~/.freellmapi/filters/*.json` for user-owned filters;
- `.freellmapi/filters.json` in the project, only when **Trust project filter files** is enabled.

Project filters are disabled by default because repositories may be untrusted.

## Design boundaries

The built-in path is deterministic, synchronous, dependency-light, and provider-neutral. It does not call another model, use a learned token-pruning model, rewrite images, or emit opaque provider-specific compaction blocks. Those approaches can be useful when a compatible upstream provider or agent runtime owns the context state, but silently translating them across providers would weaken the fail-open and fidelity guarantees of this router.

## Settings, preview, and statistics APIs

Authenticated admin clients can use:

- `GET /api/settings/compression` — read the effective configuration.
- `PUT /api/settings/compression` — update modes, engines, limits, and trust controls.
- `POST /api/compression/preview` — inspect compressed output and per-engine results without affecting live statistics.
- `GET /api/compression/stats` — read rolling aggregate and per-engine savings and fidelity-gate discards.

MCP clients can read the same live aggregates with the `compression_stats` tool. Statistics contain counts, timings, and estimated savings only; request bodies are never retained.
