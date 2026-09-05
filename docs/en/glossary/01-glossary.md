# Glossary

| Term | Meaning |
| --- | --- |
| **Headroom** | Remaining quota for a model/key before rate limit: `1 − max(RPM/RPD/TPM/TPD used)`. `0`=exhausted, `1`=full. Tunable via `HEADROOM_RAMP_START`/`HEADROOM_FLOOR` (`../architecture/01-routing-and-bandit-scoring.md`). |
| **RPD / TPD** | Requests / tokens per day — daily quota windows (`ratelimit.ts:modelWindowUsedFraction`, 5s TTL). |
| **RPM / TPM** | Requests / tokens per minute — short-window quota. |
| **Pool key** | Shared quota pool identifier (`provider-quota.ts:inferQuotaPoolKey`), e.g. `openrouter::free`, `google::project`, `custom::key123`. Keys in the same pool share one allowance. |
| **Least-remaining** | Key selection strategy (`c4c0221`) that picks the key with the most remaining quota in the pool (`services/router.ts:getKeySelectionStrategy`), skipping `::account` pools. |
| **`auto:<name>`** | Named fallback chain exposed as a selectable model in `GET /v1/models` (`cc1e985`) — e.g. `auto:fast` routes only through that chain. |
| **Model-age gate** | Catalog sync rule: new models are `premium` for 30 days then become `free` on the next signed sync (`services/catalog-sync.ts`). |
| **Bandit router** | Thompson-sampling router (`services/router.ts` + `scoring.ts`) that balances reliability/speed/intelligence/headroom posteriors with 10% explore. |
| **In-flight window** | Concurrent request deduplication window — **not** deduplicated for idempotency (`95bc46f`, `services/idempotency.ts:16-20`) — a concurrent retry with the same `Idempotency-Key` may race. |
| **TRUST_PROXY** | Env var (`.env.example:314`, `lib/config.ts:95-110`) forwarded to Express `trust proxy` so analytics/rate limiting see real client IP via `X-Forwarded-For`/`Proto`. Default `false` (no spoof). |
| **`FREEAPI_SHOT`** | Desktop capture mode flag in `desktop/src/main.ts` for screenshots. |
| **`freellmapi-…`** | Pooled fallback chain identifier — the gateway's single logical model that fans out over the fallback ladder. |

See also: [Architecture](../architecture/OVERVIEW.md), [Routing & bandit scoring](../architecture/01-routing-and-bandit-scoring.md), [Quota & cooldown](../architecture/02-quota-and-cooldown-engine.md).
