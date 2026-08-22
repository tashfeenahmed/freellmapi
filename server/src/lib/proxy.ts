import http from 'http';
import https from 'https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSetting } from '../db/index.js';
import { assertProviderUrlAllowed, isLoopbackOrPrivateHostname } from './url-guard.js';

// #590 (per-key proxy): the SAME provider may be reached through different
// exit IPs per key (geo-ban / risk-control avoidance). Providers are process
// singletons, so the per-key override cannot live on the provider instance —
// it rides request-scoped AsyncLocalStorage instead, set by the dispatcher
// around a provider call and read here in proxyFetch.
const perKeyProxyStore = new AsyncLocalStorage<string>();

/** Run `fn` with a per-key proxy override in effect; empty URL = global proxy. */
export function withKeyProxy<T>(proxyUrl: string | undefined, fn: () => T): T {
  return perKeyProxyStore.run(proxyUrl ?? '', fn);
}


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

// SOCKS schemes socks-proxy-agent understands. `socks5h`/`socks4a` are the
// "resolve DNS at the proxy" variants (#630) — the ones that matter on
// DNS-poisoned networks, where resolving the upstream hostname locally is
// exactly what fails. They are ordinary SOCKS URLs to the agent; only our
// scheme detection ever needed teaching.
const SOCKS_SCHEMES = ['socks5:', 'socks5h:', 'socks4:', 'socks4a:'] as const;

/** Every proxy scheme the app accepts. Shared with the settings validator. */
export const PROXY_SCHEMES: readonly string[] = ['http:', 'https:', ...SOCKS_SCHEMES];

/** True when the URL names a SOCKS scheme (so it needs SocksProxyAgent, not undici). */
export function isSocksProxyUrl(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon < 0) return false;
  return (SOCKS_SCHEMES as readonly string[]).includes(url.slice(0, colon + 1).toLowerCase());
}

/** Strip any `user:pass@` userinfo so a proxy URL is safe to log. */
function redactProxyUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

// Standard proxy env vars, in the order they are consulted. PROXY_URL is the
// app's own knob and outranks the dashboard; the rest are ambient system
// settings (#353) that only apply when nothing is configured in the dashboard.
const ENV_PROXY_FALLBACKS = ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'] as const;

/** Read an env var in either the upper- or lower-case spelling. */
function readEnv(name: string): string {
  return (process.env[name] ?? process.env[name.toLowerCase()] ?? '').trim();
}

/**
 * Decide which proxy URL wins, and say where it came from.
 *
 * PROXY_URL → dashboard setting → ALL_PROXY → HTTPS_PROXY → HTTP_PROXY.
 *
 * PROXY_URL stays on top because it has always documented itself as taking
 * precedence (the dashboard hint says so). The standard vars sit *below* the
 * dashboard: they're usually exported machine-wide for curl/git, so a proxy a
 * user deliberately typed into the UI must not be silently overridden by them.
 */
function resolveProxySource(dbValue: string): { url: string; source: string } {
  const explicit = readEnv('PROXY_URL');
  if (explicit) return { url: explicit, source: 'PROXY_URL' };

  const db = dbValue.trim();
  if (db) return { url: db, source: 'dashboard' };

  for (const name of ENV_PROXY_FALLBACKS) {
    const value = readEnv(name);
    if (value) return { url: value, source: name };
  }
  return { url: '', source: 'none' };
}

/**
 * Parse a NO_PROXY list into match rules. Entries are hosts or suffixes,
 * comma-separated: `localhost,.internal.corp,example.com,*`. A bare domain
 * also covers its subdomains, matching curl/git behaviour.
 */
function parseNoProxy(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(s => (s.startsWith('*.') ? s.slice(1) : s));
}

/** True when NO_PROXY says this hostname must be reached directly. */
function noProxyMatches(hostname: string): boolean {
  if (_noProxyRules.length === 0) return false;
  // Trailing dot (FQDN form) and IPv6 brackets are noise for matching.
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

  for (const rule of _noProxyRules) {
    if (rule === '*') return true;
    // A `host:port` qualifier narrows the rule to one port; we match on host,
    // so compare the host half. Guarded so bare IPv6 rules aren't mangled.
    const bare = /^[^:]+:\d+$/.test(rule) ? rule.slice(0, rule.lastIndexOf(':')) : rule;
    if (!bare) continue;
    if (bare.startsWith('.')) {
      if (host === bare.slice(1) || host.endsWith(bare)) return true;
    } else if (host === bare || host.endsWith(`.${bare}`)) {
      return true;
    }
  }
  return false;
}

// Module-level proxy URL.
let _proxyUrl = '';
let _proxyEnabled = true;
let _bypassPlatforms = new Set<string>();
let _noProxyRules: string[] = [];
// Escape hatch for the `ssh -D` tunnel case — see shouldBypassProxy.
let _proxyLocalDestinations = false;
let _initialized = false;

// Cache.
let cached: {
  dispatcher: unknown | undefined;
  proxyUrl: string;
  isSocks: boolean;
  ts: number;
} | null = null;
const CACHE_TTL_MS = 30_000;

// #590: per-key proxy dispatchers, keyed by the key's proxy URL. Independent
// of the global cache so a per-key override never poisons the global one.
//
// A working dispatcher is cached for as long as it stays in the map: the cache
// key IS the whole proxy URL, so unlike the global entry (whose URL can change
// under it) it can never go stale — re-building it on a timer would only churn
// connection pools. A FAILED build is cached briefly instead, so a proxy that
// was down doesn't stay written off forever.
//
// The map is bounded: entries are per distinct proxy URL, so at human scale
// this holds a handful, but nothing stops an operator from pointing a hundred
// keys at a hundred rotating exits. Oldest-first eviction keeps a bad day from
// turning into an unbounded pile of agents. An evicted (or expired) dispatcher
// is dropped, not closed — closing it would tear down requests still streaming
// through it; the GC collects it once they finish. Same as the global cache.
const perKeyCached = new Map<string, { dispatcher: unknown | undefined; isSocks: boolean; ts: number }>();
const PER_KEY_FAILURE_TTL_MS = 30_000;
const PER_KEY_CACHE_MAX = 32;

function rememberPerKeyDispatcher(proxyUrl: string, entry: { dispatcher: unknown | undefined; isSocks: boolean; ts: number }): void {
  // Delete-then-set so re-use moves an entry to the young end of the map and
  // eviction takes the genuinely least-recently-used URL.
  perKeyCached.delete(proxyUrl);
  perKeyCached.set(proxyUrl, entry);
  while (perKeyCached.size > PER_KEY_CACHE_MAX) {
    const oldest = perKeyCached.keys().next().value;
    if (oldest === undefined) break;
    perKeyCached.delete(oldest);
  }
}

/** Called once at startup (after initDb) and on PUT /api/settings/proxy. */
export function applyProxyUrl(dbValue: string): void {
  const { url, source } = resolveProxySource(dbValue);
  _proxyUrl = url;
  _noProxyRules = parseNoProxy(readEnv('NO_PROXY'));
  _proxyLocalDestinations = /^(1|true|yes)$/i.test(readEnv('FREEAPI_PROXY_LOCAL_DESTINATIONS'));
  cached = null;
  if (_proxyUrl) {
    console.log(`[proxy] Configured → ${redactProxyUrl(_proxyUrl)} (source: ${source})`);
    if (_noProxyRules.length > 0) {
      console.log(`[proxy] NO_PROXY direct for: ${_noProxyRules.join(', ')}`);
    }
    if (_proxyLocalDestinations) {
      console.log('[proxy] FREEAPI_PROXY_LOCAL_DESTINATIONS is set — localhost/LAN destinations go through the proxy too.');
    }
  } else {
    console.log('[proxy] Not configured — outbound requests go direct.');
  }
  _initialized = true;
}

/**
 * Hydrate the process-wide proxy state from the settings table.
 *
 * The standalone server does this in index.ts after initDb; the desktop
 * embedder (desktop/src/server-host.ts) builds the app without index.ts and
 * must call this itself — otherwise the URL saved by PUT /api/settings/proxy
 * sits in the DB but the process starts with an empty proxy and every
 * outbound request goes direct until the user re-saves the setting (#949).
 * Safe to call more than once; it is idempotent.
 */
export function restoreProxySettings(): void {
  applyProxyUrl(getSetting('proxy_url') ?? '');
  applyProxyEnabled(getSetting('proxy_enabled') !== '0'); // default: enabled
  applyProxyBypass(getSetting('proxy_bypass') ?? '');
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

/** The NO_PROXY rules currently in effect (parsed from the env at apply time). */
export function getNoProxyRules(): string[] {
  return [..._noProxyRules];
}

/**
 * Returns true when a request should NOT use the proxy.
 * True when: proxy is disabled globally, the platform is in the bypass list,
 * the upstream host is covered by NO_PROXY, or the upstream is a local/LAN
 * destination (#951 — see below).
 *
 * A loopback (127.0.0.0/8, ::1, 0.0.0.0, `localhost`) or private/LAN
 * (RFC1918, ULA, CGNAT) destination is unreachable through a remote proxy:
 * that proxy has no route to your own 127.0.0.1 and, on any network but
 * yours, none to 192.168.1.20 either. Routing it there is never useful and,
 * for SOCKS, actively harmful: an IP literal must go on the wire as ATYP 0x01
 * (an IP) no matter what the `socks5h` suffix promises, so Tor logs "giving
 * Tor only an IP address" and may refuse the connection. The
 * Ollama/llama.cpp/LM Studio case — the app's primary documented local use,
 * "on localhost or the LAN" — is exactly this.
 *
 * FREEAPI_PROXY_LOCAL_DESTINATIONS=true opts out, for the one setup where
 * proxying a local address IS the point: an `ssh -D` dynamic tunnel, where
 * http://127.0.0.1:11434 sent through the SOCKS proxy resolves at the far end
 * and reaches the REMOTE host's Ollama.
 */
function shouldBypassProxy(url: string, platform?: string): boolean {
  if (!_proxyEnabled) return true;
  if (platform && _bypassPlatforms.has(platform.toLowerCase())) return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Unparseable URL — leave the routing decision to the caller/fetch.
    return false;
  }
  if (_noProxyRules.length > 0 && noProxyMatches(hostname)) return true;
  if (!_proxyLocalDestinations && isLoopbackOrPrivateHostname(hostname)) return true;
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
    const isSocks = isSocksProxyUrl(_proxyUrl);

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
    console.error(`[proxy] Failed to create dispatcher for "${redactProxyUrl(_proxyUrl)}": ${err.message}`);
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
export type ProxyRequestType = 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'unknown';

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

/**
 * DNS `lookup` override for the SOCKS fallback path: hand back the hostname it
 * was asked to resolve, unchanged.
 *
 * socks-proxy-agent resolves the DESTINATION locally for the `socks5://` and
 * `socks4://` schemes (`shouldLookup`) and sends the proxy a bare IP; only
 * `socks5h://`/`socks4a://` pass the name through. That local resolution is
 * what breaks rule-based proxy clients (Clash and friends), which match routing
 * rules on the domain and have nothing to match once the name is gone — and on
 * a DNS-poisoned network it resolves to the poisoned address as well.
 *
 * `http.request` forwards this to the agent as `opts.lookup`, so echoing the
 * hostname makes every SOCKS scheme reach the proxy with the domain intact,
 * i.e. behave like its `h`/`a` variant. The agent only forwards the "address"
 * as the SOCKS destination host — it never inspects the address family, so the
 * `4` is a placeholder the callback signature requires.
 */
export function socksHostnameLookup(
  hostname: string,
  _options: unknown,
  callback: (err: null, address: string, family: number) => void,
): void {
  callback(null, hostname, 4);
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

  // Socket guard for the SOCKS fallback path — deliberately NOT `timeoutMs`.
  // The two clocks measure different things: http.request's `timeout` is a
  // socket INACTIVITY timer that stays armed across the whole streaming body,
  // while `timeoutMs` is a header/request deadline the caller disarms the
  // moment response headers arrive (providers/base.ts fetchWithTimeout). Mid-
  // stream time is owned by the stall watchdog and the first-byte grace
  // (#553/#584, default 90s), so pinning the socket timer to a platform's
  // 15-60s chat timeout would kill healthy streams during prefill.
  //
  // So this only ever RAISES the historical 120s floor (#666): a user with
  // PROVIDER_TIMEOUT_CUSTOM=600000 no longer dies at 120s, and the +30s grace
  // keeps the caller's abort firing first so the tagged AbortError (see
  // enrichAbort) survives instead of the bare socket 'timeout'. 0 means "no
  // timeout" (provider semantics); undefined or malformed input falls back to
  // the 120s guard rather than disabling it.
  const socketTimeoutMs = timeoutMs === 0
    ? 0
    : typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(timeoutMs + 30_000, 120_000)
      : 120_000;

  // What to reject with when the signal fires. A client-caused abort carries
  // its own marked reason (newClientAbortError in lib/error-classify.ts) —
  // preserve it so the failure isn't misclassified downstream as a provider
  // timeout; a plain timer abort keeps the tagged AbortError.
  const abortRejection = (): Error => {
    const reason = signal?.reason;
    return reason instanceof Error && reason.name !== 'AbortError' && reason.name !== 'TimeoutError'
      ? reason
      : abortError(platform, type, timeoutMs, Date.now() - startedAt);
  };

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
      timeout: socketTimeoutMs,
      // Keep the destination hostname unresolved so the SOCKS proxy does the
      // DNS. `agent` here is always a SocksProxyAgent (every socksFetch caller
      // is behind an `isSocks` branch), and the agent is the only consumer of
      // this hook — the connection to the proxy itself still resolves normally.
      lookup: socksHostnameLookup,
    }, (res) => {
      if (signal?.aborted) {
        res.destroy();
        reject(abortRejection());
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
        reject(abortRejection());
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(abortRejection());
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
  // #590: a per-key proxy override (set via withKeyProxy around the provider
  // call) takes precedence over the global proxy for THIS request. Empty
  // string (the store default) means "fall back to global".
  const perKeyUrl = perKeyProxyStore.getStore() ?? '';
  if (perKeyUrl) {
    // Every bypass still applies, unchanged: the global on/off switch, the
    // per-platform bypass list, NO_PROXY, and local/LAN destinations. A
    // per-key override says WHICH proxy to use, not that this request must be
    // proxied — an operator who turned proxying off, listed the upstream in
    // NO_PROXY, or points at a local box still gets a direct connection.
    if (!shouldBypassProxy(url, platform)) {
      const resolved = await resolvePerKeyDispatcher(perKeyUrl);
      if (resolved) {
        if (resolved.isSocks) {
          return socksFetch(url, init, resolved.dispatcher as http.Agent, platform, requestType, timeoutMs);
        }
        return fetch(url, { ...init, dispatcher: resolved.dispatcher } as unknown as RequestInit);
      }
    }
    // Per-key proxy failed to build → fall through to the global/direct path.
  }

  // Bypass check: disabled globally, this platform is exempt, the upstream
  // host is listed in NO_PROXY, or it is a local/LAN destination no proxy can
  // reach (#951).
  if (shouldBypassProxy(url, platform)) {
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

/** Build (and TTL-cache) a dispatcher for a per-key proxy URL. Returns
 *  undefined when the URL is empty or the agent fails to build. */
async function resolvePerKeyDispatcher(proxyUrl: string): Promise<{ dispatcher: unknown; isSocks: boolean } | undefined> {
  const now = Date.now();
  const hit = perKeyCached.get(proxyUrl);
  if (hit?.dispatcher) {
    rememberPerKeyDispatcher(proxyUrl, hit);
    return { dispatcher: hit.dispatcher, isSocks: hit.isSocks };
  }
  // Negative entry, still inside its cool-off: don't retry the build yet.
  if (hit && now - hit.ts < PER_KEY_FAILURE_TTL_MS) return undefined;

  try {
    const isSocks = isSocksProxyUrl(proxyUrl);
    if (isSocks) {
      const SocksAgent = await loadSocksAgent();
      const dispatcher = new SocksAgent(proxyUrl);
      rememberPerKeyDispatcher(proxyUrl, { dispatcher, isSocks: true, ts: now });
      return { dispatcher, isSocks: true };
    }
    const ProxyAgentCtor = await loadHttpProxyAgent();
    const dispatcher = new ProxyAgentCtor({ uri: proxyUrl });
    rememberPerKeyDispatcher(proxyUrl, { dispatcher, isSocks: false, ts: now });
    return { dispatcher, isSocks: false };
  } catch (err: any) {
    console.error(`[proxy] Failed to create per-key dispatcher for "${redactProxyUrl(proxyUrl)}": ${err.message}`);
    rememberPerKeyDispatcher(proxyUrl, { dispatcher: undefined, isSocks: false, ts: now });
    return undefined;
  }
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

/** Force-rebuild the outbound connection pools on the next request. Called on
 *  sleep/wake recovery to drop pooled TCP connections that died while the
 *  host was suspended (undici keeps them warm and would hand a dead socket
 *  to the first post-wake request). */
export function flushProxyCache(): void {
  // Outbound-proxy dispatcher (only in play when a proxy URL is configured).
  cached = null;
  // The default no-proxy path is bare fetch() on Node's GLOBAL undici
  // dispatcher — exactly the pool the headline laptop-lid scenario rides — so
  // nulling the proxy cache alone left the flush a no-op for most
  // deployments. Node keeps that dispatcher in the global symbol registry
  // (getGlobalDispatcher/setGlobalDispatcher read and write the same key), so
  // swap in a fresh instance of its own constructor: new requests get new
  // sockets, in-flight requests keep a reference to the old dispatcher and
  // complete undisturbed. Deliberately NOT `import('undici')`: the built-in
  // fetch uses Node's bundled copy, and the npm package isn't installed in
  // the production image (verified live — the import throws there).
  try {
    const sym = Symbol.for('undici.globalDispatcher.1');
    const current = (globalThis as Record<symbol, unknown>)[sym] as { constructor: new () => unknown } | undefined;
    // Symbol unset = no fetch has run yet, so there are no pooled sockets to drop.
    if (current?.constructor) {
      (globalThis as Record<symbol, unknown>)[sym] = new current.constructor();
    }
  } catch (err: any) {
    console.warn(`[proxy] could not replace the global fetch dispatcher on wake: ${err?.message ?? err}`);
  }
}

export interface ProxyProbeResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
  /** The URL the probe actually called, so the dashboard can say what it
   *  reached rather than leaving the operator to guess. */
  target?: string;
}

/**
 * Where the probe goes when the caller names no target and no provider key
 * can supply one.
 *
 * Deliberately NOT an AI vendor. The probe answers "can this proxy reach the
 * internet", and pointing it at a third party the install may never use makes
 * the test lie in both directions: a gateway that never calls that vendor now
 * calls it on every Test, and a network that blocks it reports a working proxy
 * as broken. `/cdn-cgi/trace` is a plain-text reachability endpoint with no
 * account, no rate limit and no regional AI-vendor blocking.
 */
export const DEFAULT_PROXY_PROBE_TARGET = 'https://www.cloudflare.com/cdn-cgi/trace';

/**
 * Test whether a proxy URL can actually route traffic (#863). Backs the
 * Settings → Outbound proxy "Test" button so an operator can verify a draft
 * value BEFORE saving it.
 *
 * `proxyUrl` empty → falls back to the saved global proxy URL (getProxyUrl);
 * when neither is set the probe runs direct, so the button is still useful
 * before any proxy has been configured.
 *
 * The probe target is supplied by the caller and should be an endpoint this
 * install genuinely uses — the /models route of a provider the operator holds
 * an enabled key for. Any HTTP response, even a 401/403 without a key, proves
 * the proxy route works; only a network-level failure (DNS, connect, timeout)
 * counts as a proxy failure.
 */
export async function probeProxyUrl(
  proxyUrl: string | undefined,
  options: { targetUrl?: string; timeoutMs?: number } = {},
): Promise<ProxyProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = Date.now();
  const url = (proxyUrl ?? '').trim() || getProxyUrl();
  // The caller passes the endpoint this install actually talks to (see
  // routes/settings.ts); the constant is only the no-providers fallback.
  const target = (options.targetUrl ?? '').trim() || DEFAULT_PROXY_PROBE_TARGET;

  try {
    let response: Response;
    if (!url) {
      response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    } else {
      const resolved = await resolvePerKeyDispatcher(url);
      if (!resolved) {
        return { ok: false, latencyMs: Date.now() - started, target, error: 'Failed to build a proxy agent for the given URL' };
      }
      if (resolved.isSocks) {
        response = await socksFetch(target, { signal: AbortSignal.timeout(timeoutMs) }, resolved.dispatcher as http.Agent, undefined, 'unknown', timeoutMs);
      } else {
        response = await fetch(target, { ...{ signal: AbortSignal.timeout(timeoutMs) }, dispatcher: resolved.dispatcher } as unknown as RequestInit);
      }
    }
    // Any HTTP response proves the proxy route works; the upstream may still
    // answer 401/403 without a key, which is connectivity, not proxy failure.
    return { ok: true, latencyMs: Date.now() - started, status: response.status, target };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - started, target, error: err?.message ?? String(err) };
  }
}
