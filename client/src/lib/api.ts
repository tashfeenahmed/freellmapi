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

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    ...options,
  });
  if (res.status === 401) {
    // Session missing/expired — drop the token and let the AuthGate re-render.
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function logout(): Promise<void> {
  try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  clearToken();
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}
