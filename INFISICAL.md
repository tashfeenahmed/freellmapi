# Run FreeLLMAPI with provider keys from Infisical

Turnkey startup: pull your free-tier provider keys straight from Infisical at
launch, feed them to the router, and never write them to disk. Works anywhere,
as long as your Infisical account/project still has the keys.

## Prerequisites (once per machine)

1. **Node 20+** and **git**.
2. **Infisical CLI** — `brew install infisical/get-cli/infisical` (macOS/Linux),
   then `infisical login`.
3. Clone + build:
   ```bash
   git clone https://github.com/SuZhou-Joe/freellmapi.git
   cd freellmapi
   npm install
   npm run build
   ```

No `.env` needed: if `ENCRYPTION_KEY` is unset the server auto-generates one and
stores it next to the SQLite DB (`server/data/.encryption-key`). Back that file
up if you want your stored keys to survive a reset.

## Start

```bash
npm run start:infisical
```

That runs:

```bash
infisical run --projectId <PROJECT_ID> --env dev -- node start-with-infisical.mjs
```

- Dashboard + API: http://localhost:3001  (API base URL: `.../v1`)
- The unified `freellmapi-…` bearer token is printed in the logs on first boot
  and shown on the dashboard **Keys** page.

### Overriding project / environment

Defaults are baked into the `start:infisical` script but can be overridden:

```bash
INFISICAL_PROJECT_ID=<other-id> INFISICAL_ENV=staging npm run start:infisical
```

## How keys are mapped

`start-with-infisical.mjs` maps Infisical secret names to FreeLLMAPI platform
slugs and injects them via `FREEAPI_CONFIG_JSON` (in-memory only):

| Infisical secret          | Platform slug |
| ------------------------- | ------------- |
| `GROQ_API_KEY`            | `groq`        |
| `GOOGLE_AI_STUDIO_API_KEY`| `google`      |
| `COHERE_API_KEY`          | `cohere`      |
| `CLOUDFLARE_API_TOKEN`    | `cloudflare`  |
| `HUGGINGFACE_API_TOKEN`   | `huggingface` |
| `OPENROUTER_API_KEY`      | `openrouter`  |
| `CEREBRAS_API_KEY`        | `cerebras`    |

Add a provider by adding its `SECRET_NAME: 'slug'` entry to the `MAP` in
`start-with-infisical.mjs`. Missing secrets are skipped silently.

## Smoke test

```bash
KEY=<unified-key-from-logs>
curl -s http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}],"max_tokens":20}'
```
