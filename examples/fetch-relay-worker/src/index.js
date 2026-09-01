const TARGET_HEADER = 'Fetch-Relay-Target';
const AUTH_HEADER = 'Fetch-Relay-Authorization';
const REQUEST_ID_HEADER = 'Fetch-Relay-Request-ID';
const REDIRECT_HEADER = 'Fetch-Relay-Location';

const BLOCKED_REQUEST_HEADERS = new Set([
  'accept-encoding', 'connection', 'content-length', 'cookie', 'expect',
  'forwarded', 'host', 'keep-alive', 'origin', 'proxy-authenticate',
  'proxy-authorization', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    if (request.method === 'OPTIONS' && request.headers.has('Access-Control-Request-Method')) {
      const headers = new Headers();
      applyCors(headers);
      headers.set('Access-Control-Allow-Methods', request.headers.get('Access-Control-Request-Method') || 'GET');
      headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || `${AUTH_HEADER}, ${TARGET_HEADER}`);
      headers.set('Access-Control-Max-Age', '86400');
      headers.set(REQUEST_ID_HEADER, requestId);
      return new Response(null, { status: 204, headers });
    }

    if (!env.RELAY_TOKEN) return jsonError(503, 'relay_not_configured', requestId);
    if (!(await verifyBearerToken(request.headers.get(AUTH_HEADER), env.RELAY_TOKEN))) {
      console.warn(JSON.stringify({ event: 'relay.rejected', requestId, reason: 'unauthorized' }));
      return jsonError(401, 'unauthorized', requestId);
    }
    if (request.method === 'CONNECT' || request.method === 'TRACE') {
      return jsonError(405, 'method_not_allowed', requestId);
    }

    const targetValue = request.headers.get(TARGET_HEADER);
    if (!targetValue) return jsonError(400, 'missing_target_header', requestId);

    let target;
    try {
      target = validateTarget(targetValue, request.url);
    } catch (error) {
      const code = error instanceof RelayInputError ? error.code : 'invalid_target';
      console.warn(JSON.stringify({ event: 'relay.rejected', requestId, reason: code }));
      return jsonError(400, code, requestId);
    }

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers: sanitizeRequestHeaders(request.headers),
        body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
        redirect: 'manual',
        cache: 'no-store',
        signal: request.signal,
      });
      const responseHeaders = sanitizeResponseHeaders(upstream.headers);
      const location = upstream.headers.get('location');
      if (location) responseHeaders.set(REDIRECT_HEADER, location);
      applyCors(responseHeaders);
      responseHeaders.set(REQUEST_ID_HEADER, requestId);
      responseHeaders.set('Cache-Control', 'no-store');
      console.log(JSON.stringify({
        event: 'relay.response', requestId, method: request.method,
        targetHost: target.hostname, targetProtocol: target.protocol,
        status: upstream.status, ttfbMs: Date.now() - startedAt,
        colo: request.cf?.colo ?? null,
      }));
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      const aborted = request.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      console.error(JSON.stringify({
        event: 'relay.error', requestId, targetHost: target.hostname,
        errorType: aborted ? 'aborted' : 'upstream_fetch_failed',
        durationMs: Date.now() - startedAt,
      }));
      return jsonError(aborted ? 499 : 502, aborted ? 'request_aborted' : 'upstream_fetch_failed', requestId);
    }
  },
};

class RelayInputError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function verifyBearerToken(value, expected) {
  const provided = value?.startsWith('Bearer ') ? value.slice(7) : '';
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function validateTarget(value, relayUrl) {
  if (value.length > 16384) throw new RelayInputError('target_too_long');
  let target;
  try { target = new URL(value); } catch { throw new RelayInputError('invalid_target'); }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new RelayInputError('unsupported_protocol');
  if (target.username || target.password) throw new RelayInputError('target_credentials_forbidden');
  if (target.hash) throw new RelayInputError('target_fragment_forbidden');
  const hostname = target.hostname.toLowerCase();
  if (hostname === new URL(relayUrl).hostname.toLowerCase()) throw new RelayInputError('relay_loop_forbidden');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':') || /^\[.*\]$/.test(hostname)) {
    throw new RelayInputError('ip_literal_forbidden');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || hostname === 'metadata.google.internal') {
    throw new RelayInputError('local_target_forbidden');
  }
  return target;
}

function sanitizeRequestHeaders(input) {
  const output = new Headers();
  for (const [name, value] of input) {
    const lower = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower) || lower.startsWith('fetch-relay-') ||
        lower.startsWith('cf-') || lower.startsWith('x-forwarded-')) continue;
    output.append(name, value);
  }
  return output;
}

function sanitizeResponseHeaders(input) {
  const output = new Headers();
  for (const [name, value] of input) {
    const lower = name.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(lower) || lower === 'location' ||
        lower.startsWith('access-control-') || lower.startsWith('fetch-relay-')) continue;
    output.append(name, value);
  }
  return output;
}

function applyCors(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', '*');
  headers.set('Timing-Allow-Origin', '*');
}

function jsonError(status, code, requestId) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    [REQUEST_ID_HEADER]: requestId,
  });
  applyCors(headers);
  return Response.json({ error: code, requestId }, { status, headers });
}
