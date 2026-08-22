# Fetch Relay transport

FreeLLMAPI can route provider HTTP requests through an application-layer relay,
such as a Cloudflare Worker. This is different from a CONNECT/SOCKS forward
proxy: the relay receives an ordinary HTTP request, fetches the provider URL,
and streams the provider response back.

```text
FreeLLMAPI -> Fetch Relay -> LLM provider
```

Select `fetch-relay` under **Keys -> Outbound proxy**, or configure a headless
install:

```dotenv
PROXY_MODE=fetch-relay
PROXY_URL=https://relay.example.workers.dev/a-long-random-secret
```

`forward` is the default. Existing `PROXY_URL`, `ALL_PROXY`, `HTTPS_PROXY`,
`HTTP_PROXY`, SOCKS, per-key proxy, bypass, and `NO_PROXY` configurations keep
their existing behavior unless `fetch-relay` is explicitly selected.

## Relay protocol

FreeLLMAPI sends the provider request method, headers, body, and cancellation
signal to `PROXY_URL`. The preferred protocol carries the provider URL in this
header:

```http
X-FreeLLMAPI-Target-URL: https://api.provider.example/v1/chat/completions
```

For compatibility with URL-based relays, a `PROXY_URL` containing exactly
`{url}` is also supported. FreeLLMAPI replaces every placeholder with the
percent-encoded provider URL and omits the target header:

```dotenv
PROXY_URL=https://relay.example.workers.dev/secret?url={url}
```

The header form is recommended because provider URLs can contain sensitive
query parameters. Relay responses are returned without buffering. FreeLLMAPI
uses manual redirect handling for the relay request, so a redirect cannot
silently bypass the relay and connect to the provider directly.

## Security contract

A Fetch Relay handles provider credentials and request content. Only use a
relay controlled by an operator you trust. A production relay should:

- require an unguessable secret or equivalent authentication;
- allowlist exact provider hostnames and `https:` upstream URLs;
- remove `X-FreeLLMAPI-Target-URL` before the upstream request;
- not follow redirects without validating every new target;
- never log provider authorization headers or complete target URLs;
- stream request and response bodies instead of buffering them;
- reject missing or malformed targets and fail closed when its allowlist is empty.

## Cloudflare Worker reference

A deployable implementation, Wrangler configuration, and setup instructions
live in [`examples/fetch-relay-worker`](../examples/fetch-relay-worker/README.md).
It fails closed without a secret path and exact upstream-host allowlist, strips
hop-by-hop and Relay-only headers, preserves cancellation, uses manual redirect
handling, and returns `upstream.body` directly so SSE is not buffered.
