import http from 'http';
import https from 'https';

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

function socksFetch(urlStr: string, init?: RequestInit, agent?: http.Agent): Promise<Response> {
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
        reject(new DOMException('The operation was aborted', 'AbortError'));
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
        reject(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new DOMException('The operation was aborted', 'AbortError'));
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
 * configured proxy.  Pass an optional `platform` string to respect the
 * per-platform bypass list.
 *
 * When no proxy is configured, or proxy is disabled, or the platform is
 * in the bypass list, this is a direct pass-through to `fetch()`.
 */
export async function proxyFetch(url: string, init?: RequestInit, platform?: string): Promise<Response> {
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
    return socksFetch(url, init, resolved.dispatcher as http.Agent);
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
