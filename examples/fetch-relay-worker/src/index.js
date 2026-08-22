const TARGET_HEADER = 'X-FreeLLMAPI-Target-URL';

const REQUEST_HEADERS_TO_REMOVE = [
  TARGET_HEADER,
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-proto',
  'x-real-ip',
  'origin',
  'referer',
];

function allowedHosts(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function targetFrom(request) {
  const relayUrl = new URL(request.url);
  return request.headers.get(TARGET_HEADER) ?? relayUrl.searchParams.get('url');
}

function validateTarget(value, allowlist) {
  if (!value) return undefined;
  try {
    const target = new URL(value);
    if (target.protocol !== 'https:') return undefined;
    if (target.username || target.password) return undefined;
    if (target.port && target.port !== '443') return undefined;
    if (!allowlist.has(target.hostname.toLowerCase())) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

export default {
  async fetch(request, env) {
    const relayUrl = new URL(request.url);

    // RELAY_PATH is a bearer secret. Fail closed when it or the allowlist is
    // absent, and use a 404 for wrong paths so the endpoint is not advertised.
    if (!env.RELAY_PATH || relayUrl.pathname !== env.RELAY_PATH) {
      return new Response('Not found', { status: 404 });
    }

    const allowlist = allowedHosts(env.ALLOWED_UPSTREAM_HOSTS);
    if (allowlist.size === 0) {
      return new Response('Relay allowlist is not configured', { status: 503 });
    }

    const target = validateTarget(targetFrom(request), allowlist);
    if (!target) {
      return new Response('Target not allowed', { status: 403 });
    }

    const headers = new Headers(request.headers);
    for (const name of REQUEST_HEADERS_TO_REMOVE) headers.delete(name);

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
        signal: request.signal,
      });

      // Passing the ReadableStream through is what keeps SSE, audio, and other
      // streamed responses incremental. Do not call arrayBuffer/text/json.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch {
      // Do not expose target URLs, provider credentials, or runtime details.
      return new Response('Upstream request failed', { status: 502 });
    }
  },
};
