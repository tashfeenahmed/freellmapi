// GLIXEL reuses the FreeLLMAPI dashboard session: the same opaque session token
// the dashboard stores after sign-in, sent as a Bearer token to the
// session-gated /api/* routes. GLIXEL never sees a unified API key, provider
// key or encryption key; it only ever reads the session token, and only from
// the same origin.
export const SESSION_TOKEN_KEY = 'freellmapi_dashboard_token'

export function getSessionToken(): string | null {
  try { return localStorage.getItem(SESSION_TOKEN_KEY) } catch { return null }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** GET a session-gated dashboard endpoint. Throws ApiError on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('GLIXEL only reads /api/* endpoints')
  const token = getSessionToken()
  if (!token) throw new ApiError(401, 'Not signed in')
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!res.ok) throw new ApiError(res.status, `${path} answered ${res.status}`)
  return (await res.json()) as T
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

// Every write GLIXEL can make, by method and path: its chat endpoint, the
// existing conversation store, and three existing Control Room actions (add a
// key, check one key, switch the routing strategy). Anything else, such as
// reading a key back, deleting keys or changing settings, is refused first.
type WriteMethod = 'POST' | 'PUT' | 'DELETE'
const WRITABLE: Array<[WriteMethod, RegExp]> = [
  ['POST', /^\/api\/glixel\/chat$/],
  ['POST', /^\/api\/conversations$/],
  ['PUT', /^\/api\/conversations\/\d+$/],
  ['DELETE', /^\/api\/conversations\/\d+$/],
  ['POST', /^\/api\/keys$/],
  ['POST', /^\/api\/health\/check\/\d+$/],
  ['PUT', /^\/api\/fallback\/routing$/],
]

/** Thrown when GLIXEL itself refuses a write; the request never left the browser. */
export class RefusedWriteError extends Error {}

export function isWritable(method: WriteMethod, path: string): boolean {
  return WRITABLE.some(([m, re]) => m === method && re.test(path))
}

/** The server's own error message, when it sent one. Never echoes request data. */
async function serverMessage(res: Response): Promise<string | null> {
  try {
    const body = await res.json() as { error?: { message?: unknown } | string }
    const msg = typeof body.error === 'string' ? body.error : body.error?.message
    return typeof msg === 'string' && msg ? msg : null
  } catch { return null }
}

/** Authenticated request with a JSON body (or none). Returns the raw Response. */
export async function apiSend(method: WriteMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  if (!isWritable(method, path)) throw new RefusedWriteError(`GLIXEL does not ${method} ${path}`)
  const token = getSessionToken()
  if (!token) throw new ApiError(401, 'Not signed in')
  return fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
}

/** apiSend that expects a JSON answer and throws ApiError otherwise. */
export async function apiSendJson<T>(method: WriteMethod, path: string, body?: unknown): Promise<T> {
  const res = await apiSend(method, path, body)
  if (!res.ok) throw new ApiError(res.status, await serverMessage(res) ?? `${path} answered ${res.status}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}
