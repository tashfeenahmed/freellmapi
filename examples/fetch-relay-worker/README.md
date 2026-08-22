# FreeLLMAPI Fetch Relay Worker

This Worker implements the protocol documented in
[`docs/fetch-relay.md`](../../docs/fetch-relay.md). It streams requests and
responses, preserves provider Authorization, rejects non-HTTPS targets, and
only contacts exact hostnames in `ALLOWED_UPSTREAM_HOSTS`.

The `global_fetch_strictly_public` compatibility flag makes public Worker URLs
go through Cloudflare's front door instead of being treated as the relay's own
zone origin. This matters when an upstream API is itself hosted on Workers.

## Deploy

From this directory (`examples/fetch-relay-worker`):

1. Edit `ALLOWED_UPSTREAM_HOSTS` in `wrangler.jsonc` to contain only the exact
   provider hosts this FreeLLMAPI installation uses.
2. Install/authenticate Wrangler and set a long random secret path:

   ```bash
   npx wrangler@latest login
   npx wrangler@latest secret put RELAY_PATH
   ```

   Enter a value such as `/8aebf1d0-6dc6-4d78-9b4c-rotate-me`. The leading slash
   is required. Treat this value as a bearer credential.
3. Validate and deploy:

   ```bash
   npx wrangler@latest deploy --dry-run
   npx wrangler@latest deploy
   ```
4. In FreeLLMAPI, select `fetch-relay` and set the proxy URL to the deployed
   Worker URL plus the secret path:

   ```text
   https://freellmapi-fetch-relay.<your-subdomain>.workers.dev/8aebf1d0-6dc6-4d78-9b4c-rotate-me
   ```

For a headless install:

```dotenv
PROXY_MODE=fetch-relay
PROXY_URL=https://freellmapi-fetch-relay.<your-subdomain>.workers.dev/<secret-path>
```

## Security notes

- Do not deploy with a wildcard or empty upstream allowlist.
- Do not publish or log `RELAY_PATH`; rotate it if exposed.
- The Worker operator can see provider credentials and request content.
- The Worker returns upstream redirects without following them. Add redirect
  support only if every `Location` target is revalidated against the allowlist.
- The `{url}` query form is accepted for compatibility, but the default Header
  form avoids putting provider query parameters in URL logs.
- Browser CORS headers are intentionally absent because this is a server-to-
  server transport, not a public browser proxy.
