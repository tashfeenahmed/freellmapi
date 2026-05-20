const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'same-origin',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
      const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      window.location.assign(`${BASE}/login?next=${next}`);
    }
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
