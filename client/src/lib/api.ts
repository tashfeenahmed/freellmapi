const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const ADMIN_TOKEN_STORAGE_KEY = 'freellmapi.adminToken';
let pendingAdminToken: Promise<string | null> | null = null;

function getAdminToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
}

function rememberAdminToken(value: unknown) {
  if (typeof window === 'undefined') return;
  if (!value || typeof value !== 'object') return;

  const apiKey = (value as { apiKey?: unknown }).apiKey;
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, apiKey);
  }
}

function requestAdminToken(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!pendingAdminToken) {
    pendingAdminToken = Promise.resolve(window.prompt('Admin API key')?.trim() || null)
      .then(token => {
        if (token) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
        return token;
      })
      .finally(() => {
        pendingAdminToken = null;
      });
  }
  return pendingAdminToken;
}

export async function apiFetch<T>(path: string, options?: RequestInit, retryAuth = true): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const adminToken = getAdminToken();
  if (adminToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${adminToken}`);
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });
  if (res.status === 401 && retryAuth) {
    const token = await requestAdminToken();
    if (token) return apiFetch<T>(path, options, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  const body = await res.json();
  rememberAdminToken(body);
  return body;
}
