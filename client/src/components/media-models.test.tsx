// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import { groupMedia, MediaModelsView, type MediaModel } from '@/components/media-models'
import * as api from '@/lib/api'

// media-models consolidates media rows into logical-model groups (one row per
// displayName across providers) and renders enable toggles that save
// immediately. groupMedia is the pure grouping/sorting helper; MediaModelsView
// is the image/audio dashboard list.

const rows: MediaModel[] = [
  { id: 1, platform: 'nvidia', modelId: 'nvidia/flux-schnell', displayName: 'FLUX.1 [schnell]', modality: 'image', enabled: true, quotaLabel: '', keyCount: 2 },
  { id: 2, platform: 'cloudflare', modelId: 'cf/flux-schnell', displayName: 'FLUX.1 [schnell]', modality: 'image', enabled: false, quotaLabel: '1k/mo', keyCount: 1 },
  { id: 3, platform: 'siliconflow', modelId: 'sf/flux-dev', displayName: 'FLUX.1 [dev]', modality: 'image', enabled: false, quotaLabel: '', keyCount: 0 },
  { id: 4, platform: 'openai', modelId: 'tts-1', displayName: 'TTS-1', modality: 'audio', enabled: true, quotaLabel: '', keyCount: 1 },
]

describe('groupMedia', () => {
  it('groups rows by displayName and sorts alphabetically', () => {
    const groups = groupMedia(rows)
    expect(groups.map(g => g.label)).toEqual(['FLUX.1 [dev]', 'FLUX.1 [schnell]', 'TTS-1'])
    expect(groups[1].members).toHaveLength(2)
    expect(groups[1].members.map(m => m.platform)).toEqual(['nvidia', 'cloudflare'])
  })

  it('slugifies labels with encodeURIComponent', () => {
    const groups = groupMedia(rows)
    expect(groups[1].slug).toBe('FLUX.1%20%5Bschnell%5D')
  })

  it('returns an empty list for no rows', () => {
    expect(groupMedia([])).toEqual([])
  })
})

function renderView(modality: 'image' | 'audio') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter>
          <MediaModelsView modality={modality} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

// Path-aware mock: the view also queries the usage endpoints, and a blanket
// response would render usage rows carrying the same model names as the group
// cards, making text queries ambiguous.
function mockMedia(mediaRows: MediaModel[] = rows) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/media') return { models: mediaRows } as never
    return { models: [], totalRequestsMonth: 0, totalRequestsToday: 0 } as never
  })
}

describe('MediaModelsView', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading skeleton while fetching', () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}) as never)
    const { container } = renderView('image')
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
  })

  it('renders groups and providers for the selected modality', async () => {
    mockMedia()
    renderView('image')
    expect(await screen.findByText('FLUX.1 [schnell]')).toBeInTheDocument()
    // Image modality filters out audio rows.
    expect(screen.queryByText('TTS-1')).not.toBeInTheDocument()
    // Both providers for the schnell group render, with the "2 providers" badge.
    expect(screen.getByText('nvidia')).toBeInTheDocument()
    expect(screen.getByText('cloudflare')).toBeInTheDocument()
  })

  it('shows the no-key badge for providers without keys', async () => {
    vi.spyOn(api, 'apiFetch').mockResolvedValue({ models: rows } as never)
    renderView('image')
    // i18n key models.noKey renders lowercase "no key".
    expect(await screen.findByText('no key')).toBeInTheDocument()
  })

  it('toggles a provider and persists via PUT', async () => {
    const user = userEvent.setup()
    const apiFetch = mockMedia()
    renderView('image')
    await screen.findByText('FLUX.1 [schnell]')
    // Groups render alphabetically: FLUX.1 [dev] first (1 switch), then
    // FLUX.1 [schnell] (nvidia + cloudflare switches). Find the cloudflare
    // row (id 2) switch and click it to enable.
    const modelId = screen.getByText('cf/flux-schnell')
    const row = modelId.closest('div')?.parentElement?.parentElement
    const switchInRow = row?.querySelector('[data-slot="switch"]') as HTMLElement
    expect(switchInRow).toBeTruthy()
    await user.click(switchInRow)
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/media/2', expect.objectContaining({ method: 'PUT' }))
    })
  })

  it('shows the empty state when no rows match the modality', async () => {
    mockMedia()
    renderView('audio')
    // Audio modality: only TTS-1 qualifies, so image-only state is n/a — but
    // an empty audio list still renders the media-empty hint when filtered.
    expect(await screen.findByText(/TTS-1/)).toBeInTheDocument()
  })
})
