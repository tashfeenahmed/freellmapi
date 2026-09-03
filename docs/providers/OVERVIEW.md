# Provider integrations overview

## Scope

This domain documents FreeLLMAPI's provider layer: the platforms the gateway aggregates, how each is authenticated and adapted, and how per-key quota accounting, cooldowns, and health checks keep free tiers usable behind one OpenAI-compatible API.

The authoritative sources are [`shared/types.ts`](../../shared/types.ts) (the `Platform` union), [`server/src/providers/index.ts`](../../server/src/providers/index.ts) (the runtime registry), and [`server/src/providers/base.ts`](../../server/src/providers/base.ts) (the adapter contract). The public catalog headline — roughly 34 free providers, 474 model families, 635 free endpoints (~7.4 billion tokens/month of listed capacity) — comes from the [provider table in the README](../../README.md); the catalog itself tracks fewer platforms than the type union declares because some union members are retired or user-defined rather than catalog-managed.

## File index

| File | Description |
| --- | --- |
| [01-supported-platforms.md](01-supported-platforms.md) | One row per platform declared in `shared/types.ts`: auth model (keyed/keyless), adapter class (native/OpenAI-compatible), and integration notes. Explicit counts for every grouping. |
| [02-quotas-and-cooldowns.md](02-quotas-and-cooldowns.md) | RPM/RPD and TPM/TPD window accounting, concurrency leases and opt-in caps, the cooldown ladder and its provenance classes, probe-based early recovery, back-off parsed from `Retry-After` headers and error bodies (#798), and why health checks must not burn metered quota (#882). |
| [03-adding-a-new-provider.md](03-adding-a-new-provider.md) | Contributor walkthrough: extending the `Platform` union, choosing an adapter, registration options (timeouts, keyless, extra headers), key-validation semantics, catalog seeding policy, and the tests a new provider is expected to ship. |

## Conventions

- Adapters live in [`server/src/providers/`](../../server/src/providers/); every platform registered there appears on `/v1` routing immediately — no separate enable step.
- Model rows are seeded two ways: versioned migrations for launch-time rosters, and the signed hosted catalog (`services/catalog-sync.ts`, gated on `hasProvider`) for everything catalog-managed afterwards.
- Quota limits are data, not code: `rpm_limit` / `rpd_limit` / `tpm_limit` / `tpd_limit` columns on each catalog model row drive pre-throttling; see [02-quotas-and-cooldowns.md](02-quotas-and-cooldowns.md).
