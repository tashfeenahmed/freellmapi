const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TOKEN_KEY = 'freellmapi_dashboard_token';

// Dashboard session token (#35). Stored in localStorage; sent as a Bearer on
// every /api request and cleared on a 401.
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string): void {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export const UNAUTHORIZED_EVENT = 'freellmapi:unauthorized';

// Error thrown by apiFetch on a non-2xx response. Carries the HTTP status and
// the server's machine-readable `error.type` so callers can branch on them.
export interface ApiError extends Error {
  status?: number;
  code?: string;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(options?.headers);
  const isFormData = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${BASE}${path}`, {
    // `...options` first so an explicit method/body/signal applies, but headers
    // are merged last — otherwise an options.headers would clobber the
    // Content-Type and Authorization we set here.
    ...options,
    headers,
  });
  if (res.status === 401) {
    // Session missing/expired — drop the token and let the AuthGate re-render.
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    // Surface the HTTP status and the machine-readable error type on the thrown
    // Error so callers can branch on them (e.g. the setup form reveals a code
    // field on a `setup_code_required` 403). `.message` behaviour is unchanged.
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.code = body.error?.type;
    throw err;
  }
  // A 200 whose body isn't JSON means this request never reached the API — the
  // usual cause is a reverse proxy (or static host) serving the dashboard's
  // index.html for /api/* instead of forwarding it to the backend. Without this
  // guard the raw res.json() throws an opaque "Unexpected token '<'", which on
  // the setup/login form surfaces as "sign up page cannot work". Say what's
  // actually wrong. (#257)
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON from ${path} but got a non-JSON response. The API isn't reachable at this origin — ` +
      `make sure the backend is running and that /api is forwarded to it, not served as the dashboard's static files.`,
    );
  }
}

export async function logout(): Promise<void> {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  clearToken();
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}
