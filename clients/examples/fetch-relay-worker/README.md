# Universal Fetch Relay Worker

This provider-agnostic, single-file Cloudflare Worker implements the protocol
documented in [`docs/fetch-relay.md`](../../docs/fetch-relay.md). It stores no
target-site or LLM-provider configuration. Each request supplies its complete
public HTTP(S) target through `Fetch-Relay-Target`.

## Deploy

Install Wrangler, authenticate it, set a strong secret, and deploy:

```bash
npx wrangler login
npx wrangler secret put RELAY_TOKEN
npx wrangler deploy
```

Do not put the token in `wrangler.jsonc` or commit it. Configure FreeLLMAPI:

```dotenv
PROXY_MODE=fetch-relay
PROXY_URL=https://universal-fetch-relay.<your-subdomain>.workers.dev
FETCH_RELAY_TOKEN=<the same RELAY_TOKEN>
```

Or select `fetch-relay` in **Keys -> Outbound proxy** and enter the same URL and
token. The Test button exercises the draft values before saving.

## Direct smoke test

```bash
curl https://universal-fetch-relay.<your-subdomain>.workers.dev \
  -H "Fetch-Relay-Authorization: Bearer $RELAY_TOKEN" \
  -H "Fetch-Relay-Target: https://httpbingo.org/anything?relay=smoke" \
  -H "Content-Type: application/json" \
  --data-binary '{"hello":"relay"}'
```

The Worker supports JSON, GraphQL, binary uploads, arbitrary ordinary HTTP
methods, SSE, and other streamed responses. It rejects `CONNECT`, `TRACE`, URL
credentials, IP-literal and local host targets, fragments, and relay loops. It
does not implement SOCKS, raw TCP, WebSockets, cookies, or automatic redirects.
Logs contain request ID, method, target hostname/protocol, status, TTFB, and
Cloudflare colo—not bodies, credentials, paths, or query values.
