# Fetch Relay transport

FreeLLMAPI can route provider HTTP requests through an application-layer
Fetch Relay, such as a Cloudflare Worker. Unlike a CONNECT/SOCKS forward proxy,
the relay receives an ordinary authenticated HTTP request, fetches the target,
and streams the response back.

```text
FreeLLMAPI -> Fetch Relay -> provider
```

Select `fetch-relay` under **Keys -> Outbound proxy**, enter the Relay URL and
token, or configure a headless install:

```dotenv
PROXY_MODE=fetch-relay
PROXY_URL=https://relay.example.workers.dev
FETCH_RELAY_TOKEN=generate-a-long-random-token
```

`forward` remains the default. Existing `PROXY_URL`, `ALL_PROXY`, `HTTPS_PROXY`,
`HTTP_PROXY`, SOCKS, per-key proxy, bypass, and `NO_PROXY` behavior is unchanged
unless `fetch-relay` is explicitly selected.

## Protocol

FreeLLMAPI sends the original method, body, provider headers, and cancellation
signal to `PROXY_URL`, with two hop-specific control headers:

```http
Fetch-Relay-Authorization: Bearer <relay-token>
Fetch-Relay-Target: https://api.provider.example/v1/chat/completions
Authorization: Bearer <provider-key>
```

The Relay authentication and provider authentication are deliberately
separate. The query-string and `{url}` compatibility formats are not supported.
FreeLLMAPI overwrites caller-supplied Relay control headers, does not buffer the
response body, and requests manual redirect handling so a redirect cannot turn
into an accidental direct provider request.

Dashboard-saved Relay tokens are encrypted at rest and the settings API never
returns them. An empty token is supported for an intentionally unauthenticated
relay, but is not recommended. In headless deployments, `FETCH_RELAY_TOKEN`
takes precedence over the saved dashboard value.

## Security contract

A Relay can see provider credentials and request content. Use one controlled by
an operator you trust. A production Relay should authenticate every request,
remove all `Fetch-Relay-*` headers before fetching the target, reject local and
metadata destinations, handle redirects manually, avoid cookies, never log
credentials or complete target URLs, and stream rather than buffer bodies.

## Cloudflare Worker reference

[`examples/fetch-relay-worker`](../examples/fetch-relay-worker/README.md)
contains a provider-agnostic, single-file Worker. It keeps no target-site list:
each request carries its complete public HTTP(S) target in `Fetch-Relay-Target`.
The implementation authenticates with a Cloudflare secret, blocks obvious SSRF
destinations and relay loops, strips hop-specific headers and cookies, exposes
redirect locations without following them, and emits sanitized structured logs.
