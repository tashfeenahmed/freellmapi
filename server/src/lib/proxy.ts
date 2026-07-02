import http from 'http';
import https from 'https';
import { assertProviderUrlAllowed } from './url-guard.js';

// undici (ProxyAgent) and socks-proxy-agent are lazy-loaded on first proxy use
// ONLY. Importing undici at module top-level eagerly runs its web/cache init,
// which throws on some Node 20.x builds ("webidl.util.markAsUncloneable is not
// a function"). Since this module is imported by every provider via base.ts, a
// top-level undici import crashed the entire app/test suite even when no proxy
// was configured. Lazy-loading keeps the proxy feature genuinely zero-cost and
// zero-risk for the common no-proxy case.
type Ctor<T> = new (...args: any[]) => T;
let _proxyAgentCtor: Ctor<unknown> | null = null;
let _socksAgentCtor: Ctor<unknown> | null = null;

async function loadHttpProxyAgent(): Promise<Ctor<unknown>> {
  if (!_proxyAgentCtor) _proxyAgentCtor = (await import('undici')).ProxyAgent as unknown as Ctor<unknown>;
  return _proxyAgentCtor;
}
async function loadSocksAgent(): Promise<Ctor<unknown>> {
  if (!_socksAgentCtor) _socksAgentCtor = (await import('socks-proxy-agent')).SocksProxyAgent as unknown as Ctor<unknown>;
  return _socksAgentCtor;
}

// Module-level proxy URL.
let _proxyUrl = '';
let _proxyEnabled = true;
let _bypassPlatforms = new Set<string>();
let _initialized = false;

// Cache.
let cached: {
  dispatcher: unknown | undefined;
  proxyUrl: string;
  isSocks: boolean;
  ts: number;
} | null = null;
const CACHE_TTL_MS = 30_000;

/** Called once at startup (after initDb) and on PUT /api/settings/proxy. */
export function applyProxyUrl(dbValue: string): void {
  const envUrl = process.env.PROXY_URL?.trim();
  if (envUrl) {
    _proxyUrl = envUrl;
  } else {
    _proxyUrl = dbValue.trim();
  }
  cached = null;
  if (_proxyUrl) {
    const masked = _proxyUrl.replace(/\/\/[^@]*@/, '//***@');
    console.log(`[proxy] Configured → ${masked}`);
  } else {
    console.log('[proxy] Not configured — outbound requests go direct.');
  }
  _initialized = true;
}

export function getProxyUrl(): string {
  return _proxyUrl;
}

/** Toggle the proxy on/off without losing the URL. */
export function applyProxyEnabled(enabled: boolean): void {
  _proxyEnabled = enabled;
  if (!enabled) console.log('[proxy] Disabled — requests go direct.');
}

export function isProxyEnabled(): boolean {
  return _proxyEnabled;
}

/** Set which platforms bypass the proxy. Comma-separated string from DB. */
export function applyProxyBypass(platformsCsv: string): void {
  _bypassPlatforms = new Set(
    platformsCsv
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (_bypassPlatforms.size > 0) {
    console.log(`[proxy] Bypass for: ${[..._bypassPlatforms].join(', ')}`);
  }
}

export function getProxyBypassPlatforms(): string[] {
  return [..._bypassPlatforms];
}

/**
 * Returns true when a platform should NOT use the proxy.
 * True when: proxy is disabled globally, or the platform is in the bypass list.
 */
function shouldBypassProxy(platform?: string): boolean {
  if (!_proxyEnabled) return true;
  if (platform && _bypassPlatforms.has(platform.toLowerCase())) return true;
  return false;
}

/**
 * Resolve the proxy dispatcher. For SOCKS schemes this returns a
 * SocksProxyAgent; for HTTP/HTTPS it returns an undici ProxyAgent.
 */
async function resolveDispatcher(): Promise<{ dispatcher: unknown; isSocks: boolean } | undefined> {
  const now = Date.now();

  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return cached.dispatcher ? { dispatcher: cached.dispatcher, isSocks: cached.isSocks } : undefined;
  }

  if (!_initialized) applyProxyUrl('');

  if (!_proxyUrl) {
    cached = { dispatcher: undefined, proxyUrl: '', isSocks: false, ts: now };
    return undefined;
  }

  try {
    const isSocks = _proxyUrl.startsWith('socks5:') || _proxyUrl.startsWith('socks4:');

    if (isSocks) {
      const SocksAgent = await loadSocksAgent();
      const dispatcher = new SocksAgent(_proxyUrl);
      cached = { dispatcher, proxyUrl: _proxyUrl, isSocks: true, ts: now };
      return { dispatcher, isSocks: true };
    }

    const ProxyAgentCtor = await loadHttpProxyAgent();
    const dispatcher = new ProxyAgentCtor({ uri: _proxyUrl });
    cached = { dispatcher, proxyUrl: _proxyUrl, isSocks: false, ts: now };
    return { dispatcher, isSocks: false };
  } catch (err: any) {
    const masked = _proxyUrl.replace(/\/\/[^@]*@/, '//***@');
    console.error(`[proxy] Failed to create dispatcher for "${masked}": ${err.message}`);
    cached = { dispatcher: undefined, proxyUrl: _proxyUrl, isSocks: false, ts: now };
    return undefined;
  }
}

// ── SOCKS-compatible fetch via http/https modules ──

/**
 * Request kinds recognised in AbortError messages. Mirrors the values
 * written to `requests.request_type` so the abort message and the row
 * column agree on terminology.
 */
export type ProxyRequestType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown';

/**
 * Build an AbortError DOMException whose `message` carries a compact triage
 * tag in the form `<platform>, <type>, <timeout>s`. No upstream URL, no
 * credentials — the platform column in `requests` already identifies the
 * upstream and the type column identifies the request kind, so the abort
 * message just needs to round-trip what's already on the row.
 *
 * `isRetryableError()` still triggers on the literal substring "aborted".
 *
 * `elapsedMs` (when known) is appended so timeout vs. client-cancel is
 * distinguishable in logs.
 */
function abortError(
  platform: string | undefined,
  type: ProxyRequestType,
  timeoutMs: number | undefined,
  elapsedMs?: number,
): DOMException {
  const tag = describeAbort(platform, type, timeoutMs);
  const timing = typeof elapsedMs === 'number' ? ` after ${elapsedMs}ms` : '';
  return new DOMException(`The operation was aborted (${tag})${timing}`, 'AbortError');
}

/**
 * Format the `<platform>, <type>, <timeout>s` tag. Exposed for testing and
 * for callers that want to log the tag without re-throwing. Falls back
 * gracefully when fields are missing: unknown platform → 'unknown',
 * unknown type → 'unknown', no timeout → omit the trailing ', <N>s'.
 */
export function describeAbort(
  platform: string | undefined,
  type: ProxyRequestType,
  timeoutMs: number | undefined,
): string {
  const p = (platform && platform.trim()) || 'unknown';
  const t = type || 'unknown';
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return `${p}, ${t}`;
  }
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `${p}, ${t}, ${seconds}s`;
}

/**
 * Rewrite an AbortError rejection so its `.message` carries the compact
 * triage tag `<platform>, <type>, <timeout>s`. Preserves `name: 'AbortError'`
 * so `isRetryableError()` (which matches on the substring "aborted") keeps
 * classifying it as retryable. If the original error is not an AbortError,
 * it's returned unchanged.
 */
function enrichAbort(
  err: unknown,
  platform: string | undefined,
  type: ProxyRequestType,
  timeoutMs: number | undefined,
): Error {
  if (!err || typeof err !== 'object') return err as Error;
  const e = err as Error & { name?: string; cause?: unknown };
  const isAbort = e.name === 'AbortError' || /aborted/i.test(e.message ?? '');
  if (!isAbort) return e;
  const enriched = new DOMException(
    `The operation was aborted (${describeAbort(platform, type, timeoutMs)})`,
    'AbortError',
  );
  // Preserve upstream error chain so debug logs still see the original cause.
  if (e.cause !== undefined) (enriched as any).cause = e.cause;
  return enriched;
}

function socksFetch(
  urlStr: string,
  init: RequestInit | undefined,
  agent: http.Agent | undefined,
  platform: string | undefined,
  type: ProxyRequestType,
  timeoutMs: number | undefined,
): Promise<Response> {
  const url = new URL(urlStr);
  const isTls = url.protocol === 'https:';
  const transport = isTls ? https : http;
  const port = url.port || (isTls ? 443 : 80);
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
  }

  const signal = init?.signal;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, host: url.hostname },
      agent,
      servername: isTls ? url.hostname : undefined,
      rejectUnauthorized: true,
      timeout: 120_000,
    }, (res) => {
      if (signal?.aborted) {
        res.destroy();
        reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
        return;
      }

      const status = res.statusCode ?? 0;
      const statusText = res.statusMessage ?? '';

      const body = new ReadableStream({
        start(controller) {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on('end', () => controller.close());
          res.on('error', (err: Error) => controller.error(err));
        },
        cancel() {
          res.destroy();
        },
      });

      const hdrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        hdrs[k] = v as string;
      }

      resolve(new Response(body, { status, statusText, headers: hdrs }));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
      }, { once: true });
    }

    if (init?.body) {
      req.write(init.body as string);
    }
    req.end();
  });
}

/**
 * Drop-in replacement for `fetch(url, init)` that routes through the
 * configured proxy. Pass an optional `platform` string to respect the
 * per-platform bypass list.
 *
 * When no proxy is configured, or proxy is disabled, or the platform is
 * in the bypass list, this is a direct pass-through to `fetch()`.
 *
 * `requestType` and `timeoutMs` are propagated into the AbortError
 * message so triage reads `<platform>, <type>, <timeout>s`. Both default
 * to `undefined` / `'unknown'` when callers haven't been updated yet —
 * the abort still fires, it just omits the unknown fields.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function proxyFetch(
  url: string,
  init?: RequestInit,
  platform?: string,
  requestType: ProxyRequestType = 'unknown',
  timeoutMs?: number,
): Promise<Response> {
  try {
    // SSRF guard (#440): 'custom' is the only platform whose target URL is
    // user-supplied (base_url on the api_keys row), so it is re-assessed on
    // every request — a URL saved before the guard existed, edited in the DB,
    // or whose DNS now points somewhere blocked still can't reach cloud
    // metadata / link-local addresses.
    if (platform === 'custom') {
      await assertProviderUrlAllowed(url);
      // Redirects are never followed for custom providers: fetch()'s default
      // 'follow' would re-request the Location target WITHOUT re-running the
      // guard above, so a public base_url answering 302 → an internal or
      // metadata address would defeat the check. socksFetch (http.request)
      // never followed redirects; forcing redirect: 'manual' here makes every
      // path behave the same, and the 3xx is converted to an explicit error
      // below so the operator sees why instead of a confusing empty body.
      init = { ...init, redirect: 'manual' };
    }

    const response = await dispatchFetch(url, init, platform, requestType, timeoutMs);

    if (platform === 'custom' && REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location') ?? 'an unspecified location';
      throw new Error(
        `Custom provider URL blocked: upstream redirected (${response.status}) to ${location}; ` +
        'redirects are not followed for custom providers, point base_url directly at the API',
      );
    }
    return response;
  } catch (err) {
    // Rewrite bare "The operation was aborted" rejections so they carry the
    // compact triage tag. Preserves the AbortError name so
    // `isRetryableError()` still classifies the failure as retryable.
    throw enrichAbort(err, platform, requestType, timeoutMs);
  }
}

/** Route the request through the configured proxy (or straight to fetch). */
async function dispatchFetch(
  url: string,
  init: RequestInit | undefined,
  platform: string | undefined,
  requestType: ProxyRequestType,
  timeoutMs: number | undefined,
): Promise<Response> {
  // Bypass check: disabled globally, or this platform is exempt.
  if (shouldBypassProxy(platform)) {
    return fetch(url, init);
  }

  const resolved = await resolveDispatcher();

  // No dispatcher (no proxy URL configured, or it failed to build) → direct
  if (!resolved) {
    return fetch(url, init);
  }

  // SOCKS proxy → http/https fallback
  if (resolved.isSocks) {
    return socksFetch(url, init, resolved.dispatcher as http.Agent, platform, requestType, timeoutMs);
  }

  // HTTP/HTTPS proxy → undici (dispatcher is an undici extension not in TS types)
  return fetch(url, { ...init, dispatcher: resolved.dispatcher } as unknown as RequestInit);
}

/**
 * Returns true when the proxy is configured AND enabled. Used by the dashboard
 * to show the "Active" badge. Intentionally does NOT construct a dispatcher (so
 * it never triggers the lazy undici import) — "configured + enabled" is exactly
 * what the badge means.
 */
export function isProxyActive(): boolean {
  if (!_initialized) applyProxyUrl('');
  return _proxyEnabled && !!_proxyUrl;
}
