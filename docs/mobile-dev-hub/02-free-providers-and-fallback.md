# Mobile dev hub 02: Free providers, fallback routing and verification

> **How to read this page.** Every claim carries its source:
>
> - **[tested]**: run against a throwaway FreeLLMAPI instance in a cloud
>   container on 2026-10-28 (commit `1ba8f161`), with no real provider keys.
> - **[repo]**: read from this repository's code, docs or shipped model catalog.
> - **[third-party]**: from web sources that are not the provider's own
>   documentation; unverified.
> - **[verify on phone]**: you need to check it yourself.
>
> Free tiers change often. Nothing here promises a quota, and nothing here is a
> way around one.

- [1. Your Google setup](#1-your-google-setup)
- [2. How failures are reported](#2-how-failures-are-reported)
- [3. Free providers worth adding](#3-free-providers-worth-adding)
- [4. Fallback routing](#4-fallback-routing)
- [5. Secrets and backups](#5-secrets-and-backups)
- [6. Verify from your phone](#6-verify-from-your-phone)
- [7. Run the tests](#7-run-the-tests)

## 1. Your Google setup

- **The model name is real in this catalog.** `gemini-3.5-flash` is a Google
  catalog row, added in the repo's baseline migration as "2026-05 release; 1M
  ctx; tool calls verified" **[repo]**. It shows up in `/v1/models` **[tested]**.
- **It may be retired upstream.** One third-party source says Google
  deprecated `gemini-3.5-flash` on 2026-10-08 and now serves a newer Flash model
  in its place **[third-party]**. Your successful 3,186 ms reply means the name
  still resolves for your key today. To see which model actually answered, read
  the response's `model` field and the `X-Routed-Via` header (section 6)
  **[verify on phone]**.
- **Its free quota is small.** The shipped catalog gives every Gemini model
  10–15 requests/min and **20 requests/day**, and Gemma 4 models **1,000
  requests/day** **[repo]**. Third-party sources disagree with each other (some
  say about 20/day, others about 1,500/day for 3.x Flash) **[third-party]**.
- **Google meters per project.** The router counts Google models against one
  shared project pool (`google::project`) **[repo]**, and free-tier daily counts
  reportedly reset at midnight Pacific **[third-party]**. The authoritative
  numbers are on your project's rate-limit page in Google AI Studio
  **[verify on phone]**.
- **Gemma is flagged as having no tool support.** The catalog marks
  `gemma-4-26b-a4b-it` and `gemma-4-31b-it` as `supports_tools = 0` **[repo]**,
  so coding agents that call tools won't route to them. They're still useful
  for plain chat. With only a Google key, `auto` picked
  `gemma-4-26b-a4b-it` first **[tested]**.

## 2. How failures are reported

The router turns every failure into a typed error, so you can tell a provider
problem from a gateway bug **[tested]**:

| Situation | HTTP | `error.code` / `type` | Seen in test |
|---|---|---|---|
| No or wrong unified key | 401 | `authentication_error` | yes, 3–5 ms |
| Model id not in the catalog | 404 | `model_not_found` | yes |
| No usable provider key at all | 503 | `no_providers_configured` | yes, 20 ms |
| Provider rejected the key | 502 | `provider_authentication_failed`, with `X-Fallback-Trail: google/gemini-3.5-flash key1=auth` | yes: Google replied "API key not valid" in 0.39 s |
| Same request after the bad key was marked `invalid` | 503 | no usable key; "Soonest reset ~5m"; **no new upstream call** | yes, 5 ms |
| Too many requests to the gateway itself | 429 | `rate_limit_error`, with `Retry-After`, `X-RateLimit-Limit/Remaining/Reset` | yes, with `PROXY_RATE_LIMIT_RPM=6` |
| Provider quota exhausted | 429 | `quota_exceeded` / `rate_limit_exceeded` | not triggered (no real key) |
| Every candidate failed | 502/503 | `routing_exhausted`, `upstream_failed`, `upstream_unhealthy` | not triggered |

How to read them:

- A **4xx with `authentication_error` or `model_not_found`** is your request or
  your unified key.
- A **`provider_*` code, or a 429/503 naming a provider in
  `X-Fallback-Trail`,** is the provider.
- A **500 with no provider in the trail** is the most likely sign of a gateway
  bug.

Retries are bounded **[repo]**:

- **Time budget:** a 45 s failover budget per request (`FALLBACK_TIME_BUDGET_MS`).
- **Cooldown ladder:** each 429 benches that model and key, escalating
  90 s → 2 min → 10 min → 1 h → 1 day. An exhausted daily quota parks the key
  for the rest of the day instead of looping.
- **Provider-stated waits:** times from `Retry-After` and Gemini's `retryDelay`
  are honoured.
- **Bad keys:** 401s bench the key until the next health check, about 5 min.

## 3. Free providers worth adding

From the shipped catalog **[repo]**. These are snapshots; the live catalog at
[freellmapi.co/models](https://freellmapi.co/models.html) and each provider's
own console are authoritative. Read each provider's terms before adding a key:
some free tiers may use your prompts for training.

| Provider | Coding-capable models with tool calls | Catalog limits (per key) | Notes |
|---|---|---|---|
| Google | `gemini-3.5-flash`, `gemini-2.5-flash`, `gemini-3-flash-preview`, flash-lite | 10–15/min, **20/day each** | Shared project pool. Gemma 4: 1,000/day, but no tool calls |
| Groq | `openai/gpt-oss-120b`, `qwen/qwen3-32b`, `llama-3.3-70b-versatile` | 30–60/min, 1,000/day (14,400/day for `llama-3.1-8b-instant`) | Small per-minute token caps (6k–12k TPM), so large prompts hit TPM first |
| Cerebras | `gpt-oss-120b`, `zai-glm-4.7` | 5–10/min; 2,400/day (100/day for GLM) | About 1M tokens/day |
| Mistral | `codestral-latest`, `devstral-latest`, `mistral-large-latest` | **2/min**, large monthly token budget | Slow per minute; good as a coding fallback |
| NVIDIA NIM | `qwen/qwen3-coder-480b-a35b-instruct`, `deepseek-v4-*`, `kimi-k2.6` | 40/min across the account | Credit-based, so it's finite. Cold starts can take minutes |
| Cloudflare Workers AI | `gpt-oss-120b`, `qwen3-30b-a3b`, `llama-3.3-70b` | daily "neuron" allowance | Key format is `account_id:token` |
| OpenRouter | `:free` models (e.g. `llama-3.3-70b-instruct:free`) | 20/min, 200/day | All `:free` routes share one pool |

**Avoid, or read the notes first [repo]:**

- **Kilo:** keyless `:free` routes log prompts for training.
- **Cohere:** a trial key (1,000 calls/month), not a permanent free tier. A
  catalog migration comment says an earlier terms review marked it "Avoid for
  personal use"; that review table is no longer in the README.
- **OpenCode Zen and Reka:** no usable free tier any more.
- **Sail:** needs a payment method, and charges beyond its monthly credit.

**Never add** keys you don't own, shared or leaked keys, or several accounts
created to multiply one provider's free tier. That breaks the providers' terms.

## 4. Fallback routing

What already happens **[repo, partly tested]**:

- `auto` follows your **Fallback Chain** (dashboard → Fallback) and skips any
  model whose key is missing, invalid, cooling down, or over its minute or day
  window.
- A failed attempt moves to the next candidate within the 45 s budget, and the
  hops are named in `X-Fallback-Trail`.
- `auto:fast`, `auto:smart` and `auto:<named-chain>` steer a single request
  without changing the chain (`docs/en/api/01-rest-api.md`).

Recommended setup (your decision; nothing here was changed for you):

1. **Add a second and third provider** from section 3, for example Groq and
   Cerebras. With only Google, the pool is roughly 20 tool-capable requests a
   day per Gemini model.
2. **Order the chain** in the dashboard: high-volume models with tool calls
   first (Groq `gpt-oss-120b`, Cerebras `gpt-oss-120b`), then
   `gemini-3.5-flash` / `gemini-2.5-flash`, then Mistral `devstral` /
   `codestral`, then NVIDIA.
3. **Optional circuit breaker.** Add `MAX_CONSECUTIVE_UPSTREAM_FAILS=3` to
   `.env` to stop a request after 3 consecutive upstream failures instead of
   walking the whole chain. It's off by default; the trade-off is fewer
   fallback hops when the first few candidates are down.
4. **Attempt cap.** `FALLBACK_MAX_ATTEMPTS` (an integer from 1 to 100,
   default 20) caps failover hops on every chat surface: the OpenAI-compatible
   proxy, `/v1/messages`, `/v1/responses`, and the Gemini/Ollama emulation. An
   invalid value logs one warning and keeps the default 20; it never removes
   the cap. The 45 s time budget still applies on top.
5. **For debugging only,** `FALLBACK_DETAIL_HEADER=1` adds per-hop timing and
   error text to responses. Leave it off normally, because it puts provider
   error text on every response.

### Free-only routing (on by default)

The router won't send traffic anywhere that could bill you unless you opt in
(`server/src/services/free-only.ts`, using `server/src/providers/metadata.ts`).

- **Automatic routing** (`auto`, named chains, model groups, failover hops,
  auto-picked fusion slots) uses a model only if all of these hold:
  - its provider is classed `free-recurring`, or `free-model-subset` and the
    model matches the free rule (for example OpenRouter `:free`, Zhipu
    `-flash`, Google excluding Pro);
  - the repository's evidence for that is at least `medium`;
  - the provider isn't recorded as training on prompts.

  So trial keys (Cohere), recurring credits (Hugging Face, ElectronHub,
  Experiential, Speka, Moondream), promotions, paid-beyond-free (Sail,
  Volcengine), paid, retired, unknown and low-confidence providers, and your
  own custom endpoints are skipped.
- **A model you name explicitly** is also allowed when it can't bill: trial keys
  and your custom endpoints. Credit-based, promotional, paid, unknown, and
  non-free models of a mixed provider are still refused.
- **When everything usable is refused,** the response is
  `403 free_only_blocked`, naming the blocked models. It is never a misleading
  429.
- **To opt in,** set `FREE_ONLY_ALLOW_PLATFORMS=custom,sail` (comma-separated)
  in `.env`, for both modes. The server logs a warning at startup for each
  opted-in platform that can consume credit or be billed.
  `FREE_ONLY_ROUTING=off` restores the old behaviour and logs a warning too.
- **Sticky preference** from an earlier automatic choice is still treated as
  automatic.

Provider classifications come only from this repository's own notes. None
has been checked against official documentation yet (`officialDocsVerifiedOn`
is empty for every provider), so treat them as best-effort.

### Providers page

Dashboard → **Models → Providers** (`/models/providers`) shows every chat
provider on one screen:
- its state (connected, unhealthy, disabled, not set up) and free-tier class;
- whether automatic routing uses it, and the reason when it doesn't;
- its last health check, 24-hour requests, success rate and latency, and
  active cooldowns;
- remaining quota only when the provider itself reported it;
- where the free-tier classification comes from.

Its buttons use the existing endpoints: **Test**, the enable/disable switch,
**Check all keys** and **Resync catalog**. A provider with no key shows
**Add your key**, which opens the Keys page with that provider preselected. A
passing key test proves the key works; it isn't a quota measurement.

The same data is available as JSON at `GET /api/providers`. It needs a
dashboard login; the unified proxy key is refused. It never returns key
material.

## 5. Secrets and backups

- **Where provider keys go:** enter them only on the dashboard **Keys** page.
  They're encrypted with `ENCRYPTION_KEY` into `server/data/freeapi.db`, and
  Git ignores both `.env` and `server/data/` **[repo]**.
- **No key material in logs:** a fake Google key appeared 0 times in the
  server log after it was added, used, rejected and deleted **[tested]**. Keys
  are shown masked in the API.
- **Back up while stopped:** back up `.env`, `server/data/.encryption-key`
  (if it exists) and `freeapi.db*` with the server stopped. See section 8 of
  [01-android-install.md](01-android-install.md).
- **Bind address:** keep `HOST=127.0.0.1` in `.env`. The test instance
  listened only on `127.0.0.1` **[tested]**.

## 6. Verify from your phone

Run these in a second Termux session while the server runs. First store the
unified key in a 0600 header file without echoing it:

```bash
umask 077; mkdir -p ~/.config/freellmapi-hub
read -rs K; printf 'Authorization: Bearer %s\n' "$K" > ~/.config/freellmapi-hub/unified.hdr; unset K
A=~/.config/freellmapi-hub/unified.hdr; B=http://127.0.0.1:3001
```

1. **Health (expect `"status":"ok"`):**

   ```bash
   curl -s $B/api/ping; echo
   ```

2. **Auth is enforced (expect 401):**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' $B/v1/models
   ```

3. **Your Google model, with routing headers and the model that answered:**

   ```bash
   T=~/.config/freellmapi-hub   # private 0700 folder; avoids /tmp, which may not exist on Termux
   curl -s -D $T/h -o $T/b -w 'HTTP %{http_code} in %{time_total}s\n' -H @$A \
     -H 'content-type: application/json' $B/v1/chat/completions \
     -d '{"model":"gemini-3.5-flash","messages":[{"role":"user","content":"say ok"}],"max_tokens":16}'
   grep -i -E '^(x-routed-via|x-fallback-trail)' $T/h
   node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("model:",r.model,"| reply:",r.choices?.[0]?.message?.content ?? JSON.stringify(r.error))' $T/b
   ```

4. **`auto` routing.** Repeat step 3 with `"model":"auto"` and compare
   `X-Routed-Via`.

5. **Fallback.** On the dashboard, temporarily **disable** the Google key, rerun
   step 4, and confirm `X-Routed-Via` names another provider. With only Google
   configured you should instead get a 503 `no_providers_configured`. Re-enable
   the key afterwards.

6. **Usage this month:**

   ```bash
   curl -s -H @$A $B/v1/usage | head -c 600; echo
   ```

7. **Clean up the temporary response files:**

   ```bash
   rm -f ~/.config/freellmapi-hub/h ~/.config/freellmapi-hub/b
   ```

Don't load-test a real provider to see a 429. It spends your daily quota, and
the router's handling is covered by the tests in section 7.

## 7. Run the tests

From the repository root:

```bash
# hook and bootstrap tests (fast)
npm run test:hooks
npm run test:bootstrap

# Google provider, retry/back-off, rate limits, auth, error redaction, failover
cd server && npx vitest run --pool=forks --fileParallelism=false \
  src/__tests__/providers/google src/__tests__/providers/stated-retry \
  src/__tests__/routes/proxy-retry src/__tests__/routes/proxy-rate-limit \
  src/__tests__/routes/proxy-auth src/__tests__/routes/proxy-error-redaction \
  src/__tests__/routes/fallback-hardening src/__tests__/services/ratelimit \
  src/__tests__/services/routing-exhaustion src/__tests__/services/cooldown-probe \
  src/__tests__/services/router.test
```

Results in the cloud container: hook tests 9/9, bootstrap tests 2/2, and the
server subset **250/250 in 20 test files** **[tested]**. On Android the server
tests are **unverified**: they may expect `better-sqlite3`, which isn't
installed there. The cloud-only hook tests
(`node --test .claude/hooks/freellmapi-start.test.mjs`) don't apply to a phone.
