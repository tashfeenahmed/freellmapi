# Glossary

Shared vocabulary for working in this repo. Read this before touching
`server/src/services/router.ts`, `server/src/services/ratelimit.ts`,
`server/src/lib/fallback-loop.ts`, `server/src/providers/*`, or anything
under `server/src/services/model-*` / `custom-model-*`.

Deep dives live under `docs/en/` — this file defines terms, it does not
repeat implementation. When this file and a deep dive disagree, the deep
dive wins; fix this file.

## What this thing is

- **Gateway**: the whole product. One self-hosted proxy that stacks many
  providers' free tiers behind one OpenAI-compatible endpoint.
- **Pooled fallback chain**: the gateway's single logical model. Per request
  the router walks an ordered chain of models until one answers or the
  time budget runs out.

## The four nouns agents mix up

- **Platform**: a named upstream, e.g. `google`, `groq`, `openrouter`.
  The closed list lives in `shared/types.ts` (`Platform`).
- **Provider adapter**: the code file for a platform
  (`server/src/providers/<platform>.ts`). Most extend
  `OpenAICompatProvider`; a few with odd wire protocols extend
  `BaseProvider` directly.
- **Model row**: one routable `(platform, model_id)` entry in the DB,
  plus its limits, capabilities, and score inputs.
- **Key**: one stored upstream credential for a platform. A model routes
  only when it has at least one healthy, under-limit key.

## Chains, pools, catalog

- **Chain**: the ordered list of model rows tried for one request.
  Source, in priority order: active profile → global fallback config →
  `auto:` sort alias → profile by name.
- **`auto:<name>`**: a named chain exposed as a selectable model
  (`auto:fast`, `auto:smart`, …).
- **Profile**: a named chain saved in the `profile_models` table
  (e.g. "coding", "long-context").
- **Pool key**: the shared quota bucket keys draw from
  (e.g. `openrouter::free`). Keys in one pool share one allowance.
- **Catalog model**: a row delivered by the signed catalog sync.
- **Custom / relay model**: a row pointing at a user-supplied `base_url`
  (`endpoint scope` `custom:<hash>`). Same `model_id` on two relays
  is two different rows.
- **Model-age gate**: new catalog rows serve as `premium` for 30 days,
  then become `free` on the next signed sync.
- **Tombstone / override / retirement**: the three ways a catalog row
  goes away or is edited without editing the catalog: user-hidden,
  upstream end-of-life, or a local field override.

## Routing and quota

- **Router**: picks one `(platform, model, key)` per request. A
  Thompson-sampling bandit over reliability / speed / intelligence,
  multiplied by headroom guardrails — not round-robin.
- **Strategy**: the weight preset (`balanced`, `smartest`, `fastest`,
  `reliable`, `custom`, `priority`). Key selection (`auto` /
  `least-remaining`) is independent of it.
- **Headroom**: remaining quota as a 0–1 factor. Steers traffic away
  before a cap hits; it never lets a request through a real limit.
- **Quota windows**: RPM / TPM (sliding minute) and RPD / TPD (UTC day).
  Plus provider-wide pools (one account-wide cap across many models)
  and in-flight leases (in-flight requests count before they finish).
- **Hard gate vs steering**: `canMakeRequest` / `canUseTokens` say
  yes/no on the hot path. The 5-second usage snapshot only steers
  ranking. Do not treat the snapshot as permission.
- **Cooldown**: a benched `(model, key)` after 429/5xx/auth failures.
  `heuristic` (our guess, probe-eligible) vs `authoritative` (provider
  Retry-After) vs `credit` (402) vs `tier` (403). Escalates
  2 min → 10 min → 1 h → 24 h.
- **Fallback loop**: the shared retry driver every route uses
  (`server/src/lib/fallback-loop.ts`). Up to ~20 attempts inside one
  wall-clock budget; a stalled first byte cancels the attempt.
- **Degraded mode**: quota exhausted at the top of the chain, so the
  endpoint serves the next healthy tier instead of failing. Resets at
  UTC midnight.
- **Tool-call rescue**: models that emit tool calls as plain text are
  converted to real `tool_calls`. Tool requests route only to models
  that support tools.
- **Health**: background probe keeping key status fresh. `UNKEYED` =
  no key yet; `KEYED-NO-ROWS` = key stored but zero routable rows;
  `serving` = key + rows + traffic.

## Repo map

- `server/` — Express proxy (`:3001`), router, quota, providers, DB.
- `client/` — React + Vite dashboard.
- `shared/` — `types.ts`, notably the `Platform` union.
- `cli/`, `desktop/` — CLIs and desktop shell, not the hot path.
- `docs/en/architecture/` — router, quota/cooldown, streaming,
  degraded mode, catalog sync, observability.
- `docs/en/providers/` — per-platform quotas, adding a provider.
- `docs/en/glossary/01-glossary.md` — deeper term table with code refs.
- `server/src/__tests__/` — unit + integration + route tests.

## Confusables

- Platform ≠ provider adapter ≠ model ≠ key.
- Chain (ordered tries) ≠ pool (shared quota bucket).
- Catalog listing (what exists) ≠ chain (what this request tries).
- Custom model (user relay) ≠ premium model (new catalog row).
- Cooldown (benched after failure) ≠ quota (allowance not yet spent).
- Headroom (steering factor) ≠ reliability (bandit posterior).
- Profile (saved chain) ≠ strategy (score weights).

## Contributing pointers

- One change per PR; keep `npm test` green; add a test with the fix.
- Never invent provider limits, model ids, or endpoints — verify
  against the provider.
- Schema changes are file-per-migration under
  `server/src/db/migrations/`; never edit an applied migration.
- `client/src/i18n/locales/en.json` is the i18n source of truth
  (`npm run check:i18n` in `client/`).
