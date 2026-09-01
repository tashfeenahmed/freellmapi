import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A 401 must end the dashboard session ONLY when it is our auth saying so.
// Discover/probe endpoints relay an upstream provider's 401 with its status
// intact ("the endpoint rejected the key"); treating any 401 as session-expired
// signed the operator out every time they tested a bad provider key.

const TOKEN_KEY = 'freellmapi_dashboard_token'

function makeStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size },
  } as Storage
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('apiFetch 401 handling', () => {
  let events: string[]

  beforeEach(() => {
    events = []
    vi.stubGlobal('localStorage', makeStorage())
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => { events.push(e.type); return true } })
    // Node's CustomEvent (>=19) works; make sure it exists either way.
    if (typeof globalThis.CustomEvent === 'undefined') {
      vi.stubGlobal('CustomEvent', class extends Event {})
    }
    localStorage.setItem(TOKEN_KEY, 'session-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clears the token and fires the unauthorized event on a session 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'Authentication required', type: 'authentication_error' },
    })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/keys')).rejects.toMatchObject({ status: 401, code: 'authentication_error' })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(events).toContain('freellmapi:unauthorized')
  })

  it('keeps the session when a discover/probe relays an upstream 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {
      error: { message: 'The endpoint rejected the key (HTTP 401)', type: 'upstream_error' },
    })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/keys/custom/discover-models', { method: 'POST', body: '{}' }))
      .rejects.toMatchObject({ status: 401, code: 'upstream_error' })
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token')
    expect(events).toHaveLength(0)
  })

  it('keeps the session on an untyped 401 rather than guessing it expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { message: 'nope' } })))
    const { apiFetch } = await import('./api')

    await expect(apiFetch('/api/whatever')).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token')
    expect(events).toHaveLength(0)
  })
})
