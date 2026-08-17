import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import ModelDetailPage from '@/pages/ModelDetailPage'
import * as api from '@/lib/api'

// ModelDetailPage lists the providers serving one logical model, with a
// per-provider enable toggle that persists immediately (PUT /api/fallback).
// These tests drive the loading / empty / members branches and the toggle.

const entries = [
  {
    modelDbId: 11,
    priority: 1,
    effectivePriority: 1,
    penalty: 0,
    rateLimitHits: 0,
    enabled: true,
    platform: 'nvidia',
    modelId: 'nvidia/flux-schnell',
    displayName: 'FLUX.1 [schnell]',
    intelligenceRank: 1,
    speedRank: 2,
    sizeLabel: '12B',
    rpmLimit: 40,
    rpdLimit: null,
    monthlyTokenBudget: 'free · 40 RPM',
    supportsVision: false,
    supportsTools: true,
    keyCount: 1,
    groupKey: 'g1',
    canonicalId: 'flux-1',
    groupLabel: 'FLUX.1 [schnell]',
  },
  {
    modelDbId: 12,
    priority: 2,
    effectivePriority: 2,
    penalty: 0,
    rateLimitHits: 1,
    enabled: false,
    platform: 'cloudflare',
    modelId: 'cf/flux-schnell',
    displayName: 'FLUX.1 [schnell]',
    intelligenceRank: 2,
    speedRank: 1,
    sizeLabel: '12B',
    rpmLimit: null,
    rpdLimit: 1000,
    monthlyTokenBudget: '1k/mo',
    monthlyTokenBudgetTokens: 1000,
    supportsVision: true,
    supportsTools: false,
    keyCount: 1,
    groupKey: 'g1',
    canonicalId: 'flux-1',
    groupLabel: 'FLUX.1 [schnell]',
  },
  // Same display name but a different canonical model — must NOT appear.
  {
    modelDbId: 13,
    priority: 1,
    enabled: true,
    platform: 'openai',
    modelId: 'tts-1',
    displayName: 'TTS-1',
    intelligenceRank: 1,
    speedRank: 1,
    sizeLabel: '',
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '',
    supportsVision: false,
    supportsTools: false,
    keyCount: 1,
    canonicalId: 'tts-1',
  },
]

function mockApi(overrides: Record<string, unknown> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/fallback') return overrides.entries ?? entries as never
    if (path === '/api/fallback/routing') {
      return {
        strategy: 'balanced',
        scores: [
          { modelDbId: 11, reliability: 0.8, speed: 0.7, intelligence: 0.9, headroom: 0.5, rateLimit: 1, score: 0.91, totalRequests: 120 },
          { modelDbId: 12, reliability: 0.6, speed: 0.8, intelligence: 0.7, headroom: 0.9, rateLimit: 1, score: 0.84, totalRequests: 40 },
        ],
      } as never
    }
    if (path === '/api/settings/api-key') return { apiKey: 'sk-test' } as never
    return null as never
  })
}

function renderDetail(id = 'flux-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/models/detail/${encodeURIComponent(id)}`]}>
          <Routes>
            <Route path="/models/detail/:id" element={<ModelDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('ModelDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading hint while queries are in flight', () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}) as never)
    renderDetail()
    expect(screen.getByText(/Loading…/)).toBeInTheDocument()
  })

  it('renders the model not-found state when no providers match the id', async () => {
    mockApi()
    renderDetail('unknown-model')
    expect(await screen.findByText(/no configured providers/i)).toBeInTheDocument()
  })

  it('renders every provider row that serves the model', async () => {
    mockApi()
    renderDetail()
    // Both flux providers render with platform + model id ("nvidia" and
    // "cloudflare" appear in both the platform badge and the modelId text,
    // plus the provider-model-ids section, hence findAllByText).
    expect(await screen.findAllByText('nvidia')).not.toHaveLength(0)
    expect(await screen.findAllByText('cloudflare')).not.toHaveLength(0)
    expect(screen.getByText('nvidia/flux-schnell')).toBeInTheDocument()
    expect(screen.getByText('cf/flux-schnell')).toBeInTheDocument()
    // The unrelated TTS-1 provider is filtered out.
    expect(screen.queryByText('tts-1')).not.toBeInTheDocument()
    // Summary badges: 2 providers + tools + vision (union of members). The
    // vision/tools labels also appear on individual provider rows.
    expect(screen.getByText(/2 providers/)).toBeInTheDocument()
    expect((await screen.findAllByText(/vision/i)).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/tools/i)).length).toBeGreaterThan(0)
  })

  it('persists an enable toggle via PUT /api/fallback', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi()
    renderDetail()
    await screen.findAllByText('nvidia')
    // First switch = nvidia (enabled, index 0 in the members list order).
    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/fallback',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
    // The PUT body carries the full entries list with the toggled flag.
    const putCall = apiFetch.mock.calls.find(c => c[0] === '/api/fallback' && c[1]?.method === 'PUT')
    const body = JSON.parse((putCall?.[1]?.body as string) ?? '[]')
    expect(body.find((m: { modelDbId: number }) => m.modelDbId === 11)?.enabled).toBe(false)
  })
})
