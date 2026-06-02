# FreeLLMAPI as Paperclip `lmrouting`

FreeLLMAPI is running as a local OpenAI-compatible router:

- Base URL: `http://127.0.0.1:3001/v1`
- Model: `auto`
- Unified API key: read with `curl http://127.0.0.1:3001/api/settings/api-key`

For coding-agent traffic, `auto` now starts with a stable preferred chain before
falling back to the broader catalog:

1. `mistral-large-latest`
2. `mistral-medium-latest`
3. `groq/compound-mini`
4. `llama-3.3-70b-versatile`
5. `llama-3.1-8b-instant`

Provider/model errors such as upstream 404/502 are treated as fallbackable. This
keeps a bad upstream model, for example Cerebras Qwen3 returning 404, from ending
the whole OpenCode run.

## Add upstream provider keys

Add at least one real upstream provider key before using the router:

```sh
curl -sS http://127.0.0.1:3001/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"platform":"openrouter","key":"YOUR_OPENROUTER_KEY","label":"OpenRouter"}'
```

Supported `platform` values are defined in `server/src/routes/keys.ts`.

## Use directly

```sh
curl -sS http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer $(curl -sS http://127.0.0.1:3001/api/settings/api-key | sed -E 's/.*"apiKey":"([^"]+)".*/\1/')" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

## Paperclip via `opencode_local`

Paperclip does not currently expose a generic OpenAI-compatible LLM-source adapter in the checked-out code. The least invasive route is to use Paperclip's existing `opencode_local` adapter with a custom OpenCode provider named `lmrouting`.

OpenCode config prepared here:

```txt
/Users/openclaw/freellmapi/paperclip-opencode-config/opencode/opencode.json
```

Paperclip agent config:

```json
{
  "adapterType": "opencode_local",
  "adapterConfig": {
    "model": "lmrouting/auto",
    "command": "/Users/openclaw/freellmapi/node_modules/.bin/opencode",
    "env": {
      "XDG_CONFIG_HOME": "/Users/openclaw/freellmapi/paperclip-opencode-config",
      "XDG_DATA_HOME": "/Users/openclaw/freellmapi/paperclip-opencode-data",
      "FREELLMAPI_API_KEY": "freellmapi-REPLACE_WITH_CURRENT_KEY"
    }
  }
}
```

Notes:

- `opencode` must be installed on the host for `opencode_local` to run.
- This setup uses the local OpenCode binary installed in this folder, not a global install.
- The local `paperclip-opencode-config/` and `paperclip-opencode-data/` folders are runtime state and are intentionally not committed.
- Keep `FREELLMAPI_API_KEY` in Paperclip secrets or adapter env, not committed source.
- FreeLLMAPI only supports chat completions, not embeddings, images, audio, or vision.
