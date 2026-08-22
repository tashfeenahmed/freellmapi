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

async function secretPathMatches(actual, expected) {
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

function writeLog(level, event, fields) {
  const entry = JSON.stringify({ event, ...fields });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export default {
  async fetch(request, env) {
    const relayUrl = new URL(request.url);
    const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
    const started = Date.now();
    const baseLog = {
      requestId,
      method: request.method,
      colo: request.cf?.colo ?? 'unknown',
      country: request.cf?.country ?? 'unknown',
    };

    // RELAY_PATH is a bearer secret. Fail closed when it or the allowlist is
    // absent, and use a 404 for wrong paths so the endpoint is not advertised.
    if (!env.RELAY_PATH) {
      writeLog('error', 'relay_misconfigured', { ...baseLog, reason: 'missing_secret' });
      return new Response('Relay is not configured', { status: 503 });
    }
    if (!(await secretPathMatches(relayUrl.pathname, env.RELAY_PATH))) {
      writeLog('warn', 'relay_rejected', { ...baseLog, reason: 'invalid_path' });
      return new Response('Not found', { status: 404 });
    }

    const allowlist = allowedHosts(env.ALLOWED_UPSTREAM_HOSTS);
    if (allowlist.size === 0) {
      writeLog('error', 'relay_misconfigured', { ...baseLog, reason: 'empty_allowlist' });
      return new Response('Relay allowlist is not configured', { status: 503 });
    }

    const target = validateTarget(targetFrom(request), allowlist);
    if (!target) {
      writeLog('warn', 'relay_rejected', { ...baseLog, reason: 'target_not_allowed' });
      return new Response('Target not allowed', { status: 403 });
    }

    const requestLog = { ...baseLog, targetHost: target.hostname };
    writeLog('info', 'relay_request', requestLog);

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

      writeLog('info', 'relay_upstream_headers', {
        ...requestLog,
        status: upstream.status,
        durationMs: Date.now() - started,
        contentType: upstream.headers.get('content-type') ?? 'unknown',
      });

      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('X-FreeLLMAPI-Relay-Request-ID', requestId);

      let responseBody = upstream.body;
      if (responseBody) {
        let responseBytes = 0;
        responseBody = responseBody.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            responseBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
          flush() {
            writeLog('info', 'relay_response_complete', {
              ...requestLog,
              status: upstream.status,
              durationMs: Date.now() - started,
              responseBytes,
            });
          },
        }));
      }

      // Passing the ReadableStream through is what keeps SSE, audio, and other
      // streamed responses incremental. Do not call arrayBuffer/text/json.
      return new Response(responseBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      writeLog('error', 'relay_upstream_error', {
        ...requestLog,
        durationMs: Date.now() - started,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      // Do not expose target URLs, provider credentials, or runtime details.
      return new Response('Upstream request failed', { status: 502 });
    }
  },
};
