# Evidence-bound outbound policy (opt-in)

Free model selection does not establish the cost of every request feature.
For example, OpenRouter documents that [Auto Router with a free suffix can still
select paid models](https://openrouter.zendesk.com/hc/en-us/articles/51679572756123-I-used-openrouter-auto-free-or-auto-and-still-got-charged), and [PDF processing can
use separately billed parsers](https://openrouter.zendesk.com/hc/en-us/articles/51678714631323-Why-am-I-being-charged-on-a-free-model-file-and-PDF-processing-fees).
The latter depends on the model and parser configuration; not every file request costs money.

This optional local policy checks requests immediately before `proxyFetch`
dispatches them. It matches the actual destination, credential, serialized model
and operation against a locally maintained evidence registry. The router also
excludes unapproved models and credentials before allocating a route.

## Enable

The default is unchanged: leaving `STRICT_ZERO_SPEND` unset, or setting it to
exactly `false`, disables the gate. To enable it, set these variables before
starting the server:

```dotenv
STRICT_ZERO_SPEND=true
FREEAPI_USAGE_PURPOSE=research
FREEAPI_DATA_CLASS=public
PROVIDER_EVIDENCE_FILE=./data/provider-evidence.json
```

The evidence path is resolved from the server process working directory. The
normal workspace startup runs in `server/`, so this example uses `server/data/`,
which is already ignored by Git. A Docker process needs a locally mounted,
readable evidence file at the path configured inside the container.

Once the variable is set, an empty value or typo also enables the gate and fails
closed; only the exact value `false` disables it. Explicit usage values are
`research` or `commercial`; explicit data classes are `public` or `confidential`.
Missing/invalid context and missing, malformed or expired evidence deny requests.
Changing the flag changes policy enforcement; it is an operator setting, not a
restriction on the operator's own ability to change configuration.

## Prepare local evidence

Start from [the disabled example](examples/provider-evidence.example.json).
It is deliberately ineligible until all placeholders are replaced and the
operator verifies the account, model and allowed use. Keep live records in the
ignored data directory. Do not store real credentials in the JSON.

Each record binds a platform, **exact provider-native model ID**, SHA-256 of the
credential, explicitly free account plan with paid overage blocked, allowed
purpose/privacy, official source URL and a dated local account-verification
reference. The verification time cannot be in the future, the expiration must be
later, and both the verification age and evidence interval must be under/within
seven days respectively. The registry is reread for each check; editing a record
to disable or remove it takes effect on the next request without restarting.

Revocation affects new checks; it does not cancel an already-dispatched request
or stream. Keep the account's own spending controls enabled independently.

For a credential already present in a local environment variable, its fingerprint
can be calculated without printing the credential:

```sh
node -e "const {createHash}=require('node:crypto');const k=process.env.LOCAL_PROVIDER_KEY;if(!k)throw Error('Set LOCAL_PROVIDER_KEY locally');console.log(createHash('sha256').update(k).digest('hex'))"
```

For Cloudflare, `accountId` is also required and must match the 32-character
lowercase hexadecimal account ID in the request URL and stored credential.
Fingerprint the token portion only, not the stored `accountId:token` string.

`source` validates the HTTPS hostname (`openrouter.ai`, `console.groq.com`,
`ai.google.dev`, or `developers.cloudflare.com` for the corresponding platform).
The gate does not fetch that page or verify the truth of `accountEvidence`.
These fields are operator attestations, not signatures or independent billing
evidence. `confidential-approved` likewise records an operator approval; it does
not independently establish a provider's retention or privacy behavior.

## Supported request shapes

The initial transport allowlist is OpenRouter, Groq, Google Gemini and Cloudflare.
Only their reviewed HTTPS origins and chat paths are accepted. OpenRouter permits
canonical `publisher/model:free` IDs and the `openrouter/free` aggregate; the
aggregate is restricted to public research use. Other platforms still require
an exact model record. Provider/model support does not mean every model or
account has been tested against a real service.

Text and ordinary function calls are allowed; file/image/audio inputs, built-in
search/media tools, OpenRouter plugins, fallback model lists, unknown top-level
options and other operations are rejected. This deliberately conservative first
phase does not try to prove that a particular parser or media feature is free.
The final serialized payload is checked, not the original API envelope: features
discarded by an adapter cannot be inferred from that payload. Gemini policy
errors during remote-image preparation propagate instead of silently dropping
the image and sending text.

Reviewed metadata GETs (`models` and Cloudflare token verification) require a
currently attested credential. HTTP redirects are disabled, and application-layer
fetch relays are rejected when the request would use one. Direct connections and
ordinary HTTP/SOCKS transport proxies continue to work within the policy.

## Errors, routing and budgets

Policy rejections carry `code=zero_spend_blocked` and are not retryable provider
failures: the fallback loop stops instead of benching the model or trying another
provider with the same disallowed request. The OpenAI chat/completions and
Responses surfaces return a 403 `permission_error` with that code. Anthropic
Messages returns a 403 `permission_error` in its own error envelope. No policy
error is added to the upstream model-access-forbidden classification.

Local denials before transmission are returned to the client and logged by the
fallback loop, but do not create upstream request/error/token rows. This keeps
the model reliability scorer and monthly usage history free of requests that
never reached a provider. Fusion likewise excludes local denials from provider
analytics; its panel-level error envelope remains the existing Fusion format.

If evidence excludes every route before transmission, the existing routing
exhaustion response still applies; its diagnostic includes the policy exclusion.
Existing health/readiness and model-listing endpoints are not a complete policy
eligibility report and are not changed by this contribution.

Monthly request/token budgets, provider quotas and concurrency limits remain
separate admission checks. An unapproved candidate never reserves monthly budget;
an approved route retains the original reservation and releases it on completion
or failure, including a policy rejection after selection.

## Scope and verification

This feature constrains reviewed requests that pass through `proxyFetch`. It is
not a whole-process network sandbox, a provider billing guarantee, remote
attestation or a replacement for checking the account and pricing. Connectivity
diagnostics, catalog/update retrieval and other direct networking paths are
outside this gate. A future path that bypasses `proxyFetch` needs its own review.

The targeted suites use synthetic credentials, in-memory SQLite and loopback
HTTP. They verify transport blocking, streaming/non-streaming adapters, live
revocation after selection, HTTP error semantics and coexistence with monthly
request/token budgets. Run:

```sh
npm run test:outbound-policy
npm test
npm run lint
npm run build
```

The normal CI suite automatically includes the new test files; no additional
workflow or real API credential is required. This contribution ports the focused
outbound policy from Mixriaoliao's community hardening work. Other hardening
changes, such as listener defaults or key export controls, are outside this PR.
