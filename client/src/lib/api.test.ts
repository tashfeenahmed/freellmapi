import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as api from '@/lib/api'

// localStorage is polyfilled by vitest.setup.ts. We drive apiFetch by stubbing
// the global fetch with a Response-like object (status/ok/json/text/statusText).
function makeResponse(opts: {
  status?: number
  ok?: boolean
  json?: unknown
  text?: string
  statusText?: string
}) {
  const { status = 200, ok = true, json, text, statusText = '' } = opts
  return {
    status,
    ok,
    statusText,
    json: async () => json,
    text: async () => text ?? (json === undefined ? '' : JSON.stringify(json)),
  } as unknown as Response
}

describe('token storage helpers', () => {
  beforeEach(() => {
    api.clearToken()
    window.localStorage.clear()
  })

  it('round-trips a token and returns null when absent', () => {
    expect(api.getToken()).toBeNull()
    api.setToken('abc123')
    expect(api.getToken()).toBe('abc123')
  })

  it('clears a token', () => {
    api.setToken('abc123')
    api.clearToken()
    expect(api.getToken()).toBeNull()
  })

  it('survives a throwing localStorage (private mode) by returning null', () => {
    const throwGetter = vi
      .spyOn(window.localStorage, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    expect(api.getToken()).toBeNull()
    throwGetter.mockRestore()
  })
})

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    api.clearToken()
  })

  it('returns parsed JSON on a 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ status: 200, json: { hello: 'world' } })),
    )
    const data = await api.apiFetch<{ hello: string }>('/api/ping')
    expect(data).toEqual({ hello: 'world' })
  })

  it('sends the stored token as a Bearer Authorization header', async () => {
    api.setToken('tok-xyz')
    const fetchMock = vi.fn(async () => makeResponse({ status: 200, json: {} }))
    vi.stubGlobal('fetch', fetchMock)
    await api.apiFetch('/api/ping')
    const calledWith = fetchMock.mock.calls[0][1] as RequestInit
    expect((calledWith.headers as Record<string, string>).Authorization).toBe('Bearer tok-xyz')
  })

  it('clears the token and fires UNAUTHORIZED_EVENT on a 401, then throws', async () => {
    api.setToken('tok-xyz')
    const events: string[] = []
    window.addEventListener(api.UNAUTHORIZED_EVENT, () => events.push('unauth'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({ status: 401, ok: false, statusText: 'Unauthorized', json: { error: { message: 'expired' } } }),
      ),
    )
    await expect(api.apiFetch('/api/ping')).rejects.toThrow('expired')
    expect(api.getToken()).toBeNull()
    expect(events).toContain('unauth')
  })

  it('throws the server error message on a non-401 error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeResponse({ status: 403, ok: false, statusText: 'Forbidden', json: { error: { message: 'nope' } } }),
      ),
    )
    await expect(api.apiFetch('/api/ping')).rejects.toThrow('nope')
  })

  it('throws a helpful message when the body is not JSON (proxy served HTML)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse({ status: 200, ok: true, text: '<!doctype html><html></html>' })),
    )
    await expect(api.apiFetch('/api/ping')).rejects.toThrow(/Expected JSON from/)
  })
})

describe('logout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    api.clearToken()
    vi.restoreAllMocks()
  })

  it('clears the token, fires UNAUTHORIZED_EVENT, and ignores a failed request', async () => {
    api.setToken('tok-xyz')
    const events: string[] = []
    window.addEventListener(api.UNAUTHORIZED_EVENT, () => events.push('unauth'))
    const fetchMock = vi.fn(async () =>
      makeResponse({ status: 500, ok: false, statusText: 'Error', json: { error: { message: 'boom' } } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await api.logout()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/logout'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(api.getToken()).toBeNull()
    expect(events).toContain('unauth')
  })

  it('still clears the token when the logout request succeeds', async () => {
    api.setToken('tok-xyz')
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({ status: 200, json: {} })))
    await api.logout()
    expect(api.getToken()).toBeNull()
  })
})
