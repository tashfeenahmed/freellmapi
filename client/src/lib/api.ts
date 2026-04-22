const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function redirectToLoginOn401(path: string, status: number) {
  if (status !== 401 || typeof window === 'undefined') return;
  if (path.startsWith('/api/auth/login') || path.startsWith('/api/auth/setup')) return;
  window.location.assign(`${BASE}/login`);
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (res.status === 401) {
    redirectToLoginOn401(path, res.status);
    const body = await res.json().catch(() => ({ error: { message: 'Unauthorized' } }));
    throw new Error(body.error?.message ?? 'Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
