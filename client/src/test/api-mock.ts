import { vi } from 'vitest'
import type { ApiKey } from '../../../shared/types'
import type { FusionConfigResponse, FallbackEntry } from '@/pages/FusionPage'
import * as api from '@/lib/api'

export interface MockApiState {
  authStatus: { needsSetup: boolean; authenticated: boolean; email: string | null }
  keys: ApiKey[]
  fusionConfig?: FusionConfigResponse
  fallbackEntries?: FallbackEntry[]
  unifyEnabled?: boolean
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
  fusionConfig: {
    config: {
      mode: 'auto',
      models: [],
      judge: null,
      k: 4,
      strategy: 'synthesize',
      expose_panel: false,
    },
    maxK: 8,
  },
  fallbackEntries: [],
  unifyEnabled: true,
}

export function installApiFetchMock(state: MockApiState = defaultMockState) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/auth/status') return state.authStatus as never
    if (path === '/api/keys') return state.keys as never
    if (path === '/api/settings/fusion') return state.fusionConfig ?? defaultMockState.fusionConfig as never
    if (path === '/api/fallback') return state.fallbackEntries ?? defaultMockState.fallbackEntries as never
    if (path === '/api/settings/unify') return ({ enabled: state.unifyEnabled ?? defaultMockState.unifyEnabled } as never)
    return null as never
  })
}
