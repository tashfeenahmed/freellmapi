// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet, ApiError, isAuthError, SESSION_TOKEN_KEY } from './session'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('apiGet', () => {
  it('only reads /api/* paths', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    await expect(apiGet('/v1/models')).rejects.toThrow(/only reads \/api/)
  })

  it('fails as unauthenticated without a session, without calling the network', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const err = await apiGet('/api/providers').catch(e => e)
    expect(isAuthError(err)).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the session token as a Bearer header and surfaces HTTP errors', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 'session-token')
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(apiGet('/api/health')).resolves.toEqual({ ok: true })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token')
    fetch.mockResolvedValueOnce(new Response('', { status: 401 }))
    const err = await apiGet('/api/health').catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(isAuthError(err)).toBe(true)
  })
})
