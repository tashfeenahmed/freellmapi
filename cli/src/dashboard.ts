export interface DashboardOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
}

export interface DashboardClient {
  root: string;
  /** Authenticated JSON request. Throws on transport, auth, HTTP, and JSON errors. */
  request<T>(path: string, method?: string, body?: unknown): Promise<T>;
  /** Unauthenticated GET that reports the HTTP status instead of throwing on non-2xx. Null when unreachable. */
  probe(path: string): Promise<{ status: number; body: unknown } | null>;
}

export function gatewayRoot(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('--url must be an HTTP(S) gateway URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) URL without credentials, a query, or a fragment');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function validateTimeout(timeoutMs: number | undefined): number {
  const timeout = timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('--timeout must be a positive integer of at most 2147483647 milliseconds');
  }
  return timeout;
}

/**
 * Shared by every command that talks to the dashboard API (`keys`, `status`,
 * `usage`, `requests`). With `requireToken: false` only `probe` is usable.
 */
export function dashboardClient(options: DashboardOptions, requireToken = true): DashboardClient {
  const token = options.token?.trim();
  if (requireToken && !token) {
    throw new Error('Set FREELLMAPI_DASHBOARD_TOKEN or pass --token with a dashboard session token');
  }
  const root = gatewayRoot(options.url);
  const timeout = validateTimeout(options.timeoutMs);

  async function send(path: string, method: string, body?: unknown, auth = true): Promise<Response> {
    try {
      return await fetch(`${root}${path}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new Error('Could not complete the dashboard request. Check --url, connectivity, and --timeout.');
    }
  }

  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await send(path, method, body);
    // Provider error bodies may contain credentials. Only report the HTTP
    // status, never echo arbitrary response bodies or transport errors.
    if (response.status === 401 || response.status === 403) {
      throw new Error('Dashboard authentication failed. Supply a current dashboard session token with --token or FREELLMAPI_DASHBOARD_TOKEN.');
    }
    if (!response.ok) throw new Error(`Dashboard request failed (HTTP ${response.status})`);
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; } catch { throw new Error('The gateway returned an invalid JSON response'); }
  }

  async function probe(path: string): Promise<{ status: number; body: unknown } | null> {
    let response: Response;
    try { response = await send(path, 'GET', undefined, false); } catch { return null; }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* non-JSON body: status alone is the answer */ }
    return { status: response.status, body };
  }

  return { root, request, probe };
}
