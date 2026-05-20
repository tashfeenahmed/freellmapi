const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const DEFAULT_RETRY_OPTIONS = {
  maxRetries: 3,
  retryDelay: 1000,
  retryStatuses: [408, 429, 500, 502, 503, 504],
};

/**
 * Fetch wrapper with automatic retry for transient errors.
 * Retries on 429, 5xx, and network errors.
 */
export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { retry?: Partial<typeof DEFAULT_RETRY_OPTIONS> }
): Promise<T> {
  const { retry: retryOptions, ...fetchOptions } = options ?? {};
  const retryConfig = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { 'Content-Type': 'application/json', ...fetchOptions?.headers },
        credentials: 'same-origin',
        ...fetchOptions,
      });

      // Handle auth redirect
      if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
        const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
        window.location.assign(`${BASE}/login?next=${next}`);
      }

      // Don't retry client errors (except 429)
      if (!retryConfig.retryStatuses.includes(res.status)) {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        return res.json();
      }

      // Rate limited — wait and retry
      lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
      if (attempt < retryConfig.maxRetries) {
        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : retryConfig.retryDelay * (attempt + 1);
        await sleep(delay);
        continue;
      }
    } catch (err) {
      // Network error — retry
      if (attempt < retryConfig.maxRetries) {
        lastError = err as Error;
        await sleep(retryConfig.retryDelay * (attempt + 1));
        continue;
      }
      lastError = err as Error;
    }
  }

  throw lastError ?? new Error('Request failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simple GET request helper (no retry by default).
 */
export async function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

/**
 * POST request helper with optional retry.
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  options?: { retry?: boolean }
): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    retry: options?.retry ? {} : undefined,
  });
}

/**
 * DELETE request helper.
 */
export async function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' });
}

/**
 * PATCH request helper.
 */
export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}