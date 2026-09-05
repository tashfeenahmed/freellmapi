# Named Fallback Chains

> **Source:** `server/src/services/router.ts` (`activeChainOrThrow`, `resolveRoutingChain`), `server/src/services/profile-models.ts` (`getActiveProfileId`, `autoIncludeNewModelsForProfiles`), `server/src/routes/fallback.ts`, `server/src/routes/profiles.ts`

A *fallback chain* is the ordered set of models the router may try for a request. One chain is **active** at a time; `plain auto` always follows the active chain. Chains are stored in two places, depending on whether the install uses named profiles:

- **No profiles (legacy install):** the global `fallback_config` table.
- **Named profiles:** the `profiles` table plus a `profile_models` row per chained model, with `priority` and `enabled` per row.

Create, rename, delete, and switch the active chain on the dashboard's **Fallback** page. A profile name uses Latin letters, digits, hyphens and underscores (max 20 chars) and may not collide with the reserved routing words (`auto`, `smart`, `fast`, `cheap`, `budget`, `intelligence`, `speed`, `active`, `default`).

## Lifecycle: the empty-chain refusal

When a named profile is the active chain, `auto` is **not** a free pass over the whole catalog. The router resolves the active chain and, if it has no enabled models, **throws a client-facing `400`** rather than silently falling back to the global table:

```
The active fallback chain '<name>' has no enabled models.
Enable models for it on the Models page, switch the active chain,
or name another one with "auto:<chain>".
```

This refusal only triggers when a profile is active. A legacy install with no profiles keeps the ordinary "all models exhausted" path — the router runs the (possibly empty) global chain and returns a normal exhaustion error. The point: an empty chain must *mean* "nothing allowed", not "everything allowed". See [Commits](#commits) for the history.

`activeChainOrThrow` (`router.ts`) is the single chokepoint: `auto`, an unknown `auto:` suffix, and a blank model string all route through it. It is also what `GET /api/fallback` and `/token-usage` read, so the dashboard and the router never disagree about what the active chain contains.

## `auto:<name>` in `GET /v1/models`

Every custom routing profile is advertised to clients as a discoverable model id `auto:<name>` (`cc1e985`). `GET /v1/models` lists each named chain with its max context and availability, alongside the plain OpenAI-shaped catalog and the Claude family discovery ids. A client can switch chains per request by sending `model="auto:coding"` — no dashboard change, no key rotation. An unknown chain name returns a clear `400` instead of silently using the active chain.

Because the named-chain rows come from `profile_models` (not the global `fallback_config`), two installs can run entirely different model sets through the same unified key — the chain is selected by the request's `model` field, not by the account.

## Catalog sync and curated chains

A brand-new profile defaults to **"Start empty"** — its `profile_models` set begins empty, and it opts out of catalog-sync backfill. This is the whole point of a named chain: the operator hand-picks "these three models, in this order" and the gateway stops guessing.

The `profiles.auto_include_new_models` flag (`b3bf20f`) controls the exception:

- **`auto_include_new_models = 0` (default):** catalog sync never refills the chain. The chain stays exactly what the operator put in it. Disable this on a curated coding/vision chain so a newly-discovered model can't silently appear in it.
- **`auto_include_new_models = 1`:** every newly synced model is appended to the chain (next priority, inheriting the model's global `enabled` state). Use this on a "catch-all" profile that should grow with the catalog.

Sync runs `autoIncludeNewModelsForProfiles`, which only touches profiles with the flag set — curated chains are never touched.

## Per-row enable / disable

`PUT /api/fallback` writes a full chain replacement into the active chain, and the **Enable all / Disable all** actions (`b3bf20f`) flip every row at once. `chain_enabled` is only a marker at read time: a disabled row still consumes the provider's free allowance and still counts toward a quota pool, it is just ranked after every enabled row and skipped by `activeChainOrThrow`'s "has any enabled?" check. This is what makes a hand-built ("start empty") chain usable at all: the page renders as "the catalog, minus what I turned off", ranked after the rows I explicitly added.

## Notes, not the global table

`fallback_config` is now **only** the chain for an install that has no profiles. As soon as a profile exists, its `profile_models` is authoritative and the global table is bypassed. Treating the global table as a fallback for an empty `profile_models` set is exactly the bug `e852ff1` fixed — before that, a freshly-created "Start empty" profile rendered the whole catalog as enabled, because every consumer read zero rows as "no chain configured" and quietly fell through to `fallback_config`.

## Commits

| Commit | Change |
|--------|--------|
| `e852ff1` | **A fallback chain means itself, empty or not.** `activeChainOrThrow` returns the active profile's chain even when it has no enabled rows, instead of falling through to the global `fallback_config`. An empty curated chain now refuses with `400` rather than silently routing over the whole catalog. |
| `b3bf20f` | **Let a hand-built chain stay that hand-built.** Chains can start empty; the new `auto_include_new_models` flag keeps catalog sync from refilling curated chains; the routing table gets Enable all / Disable all. Closes #895. |
| `8bb2004` | **Named chain manager on the Fallback page.** Collapsed accordion for creating, renaming and deleting named chains, surfacing the `auto:<name>` id clients send. Refs #895 #960. |
| `cc1e985` | **List named chains as `auto:<name>` models.** Every custom routing profile shows up in `GET /v1/models` as `auto:<name>` with its max context and availability. Refs #895 #880 #960. |
