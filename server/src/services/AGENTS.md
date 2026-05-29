# services — router, rate-limiter, health

**Relevant for:** core request routing logic, rate-limit tuning, health-check behaviour  
**Depends on:** `providers/` (adapter instances), `db/` (persisted state), `lib/crypto.ts` (key decryption)

---

## Files

```
services/
├── router.ts     # 237 lines — model selection, penalty system, sticky sessions
├── ratelimit.ts  # In-memory RPM/RPD/TPM/TPD + SQLite cooldowns
└── health.ts     # Periodic key health probes
```

---

## Key patterns

- **`routeRequest()`** (router.ts): the main entry. Picks the highest-priority model that (a) has a healthy key, (b) is under its rate limits. On 429/5xx/timeout → applies penalty, skips to next model in fallback chain (up to 20 attempts).
- **429 penalty system**: `PENALTY_PER_429 = 3`, `MAX_PENALTY = 10`, `DECAY_INTERVAL_MS = 2 min`. Each time a provider returns 429, its priority is increased by N (higher = worse). Penalty decays 2 min after the last hit. All in-memory — lost on restart.
- **Sticky sessions**: `preferredModelDbId` keeps multi-turn conversations on the same model for 30 min. Prevents hallucination spike from mid-conversation model switches.
- **Rate-limit ledger**: 4 counters per `(platform, model, key)` — RPM, RPD, TPM, TPD. Checked before routing, decremented on actual usage. Cooldowns persisted to SQLite.
- **Health probes**: periodic background checks via `health.ts`. Marks keys as `healthy`, `rate_limited`, `invalid`, or `error`.

---

## Conventions (this directory only)

- **No async for DB** — router reads rate-limit state from in-memory maps (fast path). SQLite reads only for persistence/restore.
- **Penalty state is ephemeral** — intentionally not persisted. Restart resets all penalties, which is acceptable for a single-user proxy.

---

## Pitfalls

- **Penalty system is anti-greedy, not anti-starvation** — a persistently rate-limited provider can still be retried if all others are also penalized. Fine for single-user, problematic under heavy load.
- **Sticky session timer resets on each successful request** to the same model — a multi-turn conversation with >30 min between messages loses stickiness.
- **RPM/RPD/TPM/TPD are approximate** — the ledger decrements by actual token count from the response, but the initial budget is estimated from provider docs. Overages still happen.
