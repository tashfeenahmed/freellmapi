# Fallback Domain — Overview & File Index

This domain documents FreeLLMAPI's named fallback-chain system: how chains are stored, how the router resolves the active chain (and refuses when it is empty), how named chains surface to clients as `auto:<name>`, and how catalog sync interacts with curated chains. The root [`README.md`](../README.md) and [`OVERVIEW.md`](../OVERVIEW.md) index this as the operator's primary mechanism for controlling which models the router may use.

## File Index

| File | Scope |
|------|-------|
| [`01-named-chains.md`](01-named-chains.md) | Chain lifecycle, the empty-chain refusal, `auto:<name>` routing, `profiles.auto_include_new_models`, and the commits that made an empty chain authoritative. |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain. |

## Navigation

- ← [Documentation root](../README.md)
- Deep-dive: [`01-named-chains.md`](01-named-chains.md)

## Related

- [../architecture/](../architecture/) — Router, scoring, and failover internals that execute a resolved chain.
- [../api/](../api/) — The `auto:*` routing strategies and `GET /v1/models` surface that expose named chains to clients.
- [../providers/](../providers/) — Per-key quota accounting and cooldowns that gate each hop in a chain.
