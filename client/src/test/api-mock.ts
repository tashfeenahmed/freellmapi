import type { ApiKey } from '../../../shared/types'
import * as api from '@/lib/api'

// Centralised apiFetch mock so render smoke tests don't need a live backend.
// Components call `apiFetch<T>(path, opts)`; we route by path to canned data.
// Install with `vi.spyOn(api, 'apiFetch').mockImplementation(...)` via the
// returned helper, or call installApiFetchMock() directly from a test.

export interface MockApiState {
  authStatus: { needsSetup: boolean; authenticated: boolean; email: string | null }
  keys: ApiKey[]
}

export const defaultMockState: MockApiState = {
  authStatus: { needsSetup: false, authenticated: true, email: 'dev@example.com' },
  keys: [
    {
      id: 1,
      platform: 'google',
      label: 'My Google Key',
      maskedKey: 'AIza••••••••••••••••',
      status: 'healthy',
      lastCheckedAt: '2026-07-01T10:00:00.000Z',
      createdAt: '2026-06-01T10:00:00.000Z',
    } as ApiKey,
    {
      id: 2,
      platform: 'groq',
      label: '',
      maskedKey: 'gsk_••••••••••••••••',
      status: 'rate_limited',
      lastCheckedAt: null,
      createdAt: '2026-06-02T10:00:00.000Z',
    } as ApiKey,
  ],
}

/**
 * Install a path-routed apiFetch mock. Returns the vi spy so tests can inspect
 * or override it. Call from within a test (after the api module is loaded).
 */
export function installApiFetchMock(state: MockApiState = defaultMockState) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/auth/status') return state.authStatus as never
    if (path === '/api/keys') return state.keys as never
    if (path.startsWith('/api/settings') || path === '/api/fallback') {
      return {} as never
    }
    return null as never
  })
}
