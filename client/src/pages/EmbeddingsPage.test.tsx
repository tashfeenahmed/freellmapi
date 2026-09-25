// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import EmbeddingsPage from '@/pages/EmbeddingsPage'
import * as api from '@/lib/api'

// EmbeddingsPage lists embedding families with their providers, lets the
// user reorder / enable providers and change the default family locally,
// and persists those edits with a single PUT /api/embeddings.
// These tests drive the loading / render / local-edit / save / discard flows
// plus the token formatting used in family headers.

const embeddingsData = {
  defaultFamily: 'text-embedding-3',
  families: [
    {
      family: 'text-embedding-3',
      dimensions: 3072,
      maxInputTokens: 8192,
      isDefault: true,
      providers: [
        { id: 1, platform: 'openai', modelId: 'text-embedding-3-large', displayName: 'text-embedding-3-large', priority: 1, enabled: true, quotaLabel: '1M/mo', keyCount: 1 },
        { id: 2, platform: 'azure', modelId: 'text-embedding-3-large', displayName: 'text-embedding-3-large', priority: 2, enabled: false, quotaLabel: '100k/mo', keyCount: 0 },
      ],
    },
    {
      family: 'bge-m3',
      dimensions: 1024,
      maxInputTokens: null,
      isDefault: false,
      providers: [
        { id: 3, platform: 'nvidia', modelId: 'nvidia/bge-m3', displayName: 'BGE-M3', priority: 1, enabled: true, quotaLabel: 'free', keyCount: 1 },
      ],
    },
  ],
}

const usageData = {
  families: [
    { family: 'text-embedding-3', requestsToday: 12, tokensMonth: 3_500_000 },
    { family: 'bge-m3', requestsToday: 0, tokensMonth: 999 },
  ],
}

function mockApi(overrides: {
  embeddings?: unknown
  usage?: unknown
  putResponse?: unknown
} = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/embeddings' && !path.includes('/usage')) {
      return (overrides.embeddings ?? embeddingsData) as never
    }
    if (path === '/api/embeddings/usage') return (overrides.usage ?? usageData) as never
    return (overrides.putResponse ?? {}) as never
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={['/models/embeddings']}>
          <EmbeddingsPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('EmbeddingsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading skeleton while the query is in flight', () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}) as never)
    const { container } = renderPage()
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
  })

  it('renders every family with dimension badges, usage and a default badge', async () => {
    mockApi()
    renderPage()

    // Family names are links to their detail pages.
    expect(await screen.findByText('text-embedding-3', { selector: 'a' })).toBeInTheDocument()
    expect(screen.getByText('bge-m3', { selector: 'a' })).toBeInTheDocument()

    // Dimension badges.
    expect(screen.getByText('3072d')).toBeInTheDocument()
    expect(screen.getByText('1024d')).toBeInTheDocument()

    // Token cap rendered via formatTokens: 8192 -> "8.2K tok max".
    expect(screen.getByText(/8\.2K tok max/)).toBeInTheDocument()

    // Usage rows: 3.5M tokens -> "3.5M tok this month".
    expect(screen.getByText(/12 req today/)).toBeInTheDocument()
    expect(screen.getByText(/3\.5M tok this month/)).toBeInTheDocument()
    expect(screen.getByText(/999 tok this month/)).toBeInTheDocument()

    // Default badge only on the default family...
    expect(screen.getByText('Default · auto')).toBeInTheDocument()
    // ...and a single "Make default" affordance on the other family.
    expect(screen.getByRole('button', { name: 'Make default' })).toBeInTheDocument()

    // Providers from both families render.
    expect(screen.getByText('openai')).toBeInTheDocument()
    expect(screen.getByText('azure')).toBeInTheDocument()
    expect(screen.getByText('nvidia')).toBeInTheDocument()

    // No-key badge on the azure provider (keyCount 0).
    expect(screen.getByText('no key')).toBeInTheDocument()
  })

  it('reassigns the default family locally without saving', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi()
    renderPage()

    await screen.findByText('bge-m3', { selector: 'a' })
    await user.click(screen.getByRole('button', { name: 'Make default' }))

    // Now the default badge is gone for text-embedding-3; there is a Make
    // default affordance on it again (one button total).
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1)
    // The edit bar appears; nothing has been persisted yet.
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/embeddings',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('reorders providers with the up arrow and renumbers priorities', async () => {
    const user = userEvent.setup()
    mockApi()
    renderPage()

    await screen.findByText('text-embedding-3', { selector: 'a' })

    // Family with 2 providers: both rows render move controls; the first
    // provider's "Move up" is disabled, the second's is enabled.
    const upButtons = screen.getAllByRole('button', { name: 'Move up' })
    expect(upButtons).toHaveLength(2)
    const enabledUp = upButtons.find(b => !(b as HTMLButtonElement).disabled)
    expect(enabledUp).toBeTruthy()
    await user.click(enabledUp!)

    // Provider order flips and priorities are rewritten: azure is now 1.
    const rows = screen.getAllByRole('button', { name: /Move (up|down)/ })
    expect(rows).toHaveLength(4)

    // Save the reorder and verify the PUT body carries the new priorities.
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    const apiFetch = vi.mocked(api.apiFetch)
    const putCall = await waitForPut(apiFetch)
    const body = JSON.parse((putCall?.[1]?.body as string) ?? '{}')
    const providers = (body as { providers: { id: number; priority: number }[] }).providers
    expect(providers.find(p => p.id === 2)?.priority).toBe(1)
    expect(providers.find(p => p.id === 1)?.priority).toBe(2)
  })

  it('toggles a provider switch and persists enabled state via PUT', async () => {
    const user = userEvent.setup()
    mockApi()
    renderPage()

    await screen.findByText('nvidia')
    const switches = screen.getAllByRole('switch')
    // index 2 = nvidia provider (openai, azure, nvidia) in DOM order.
    await user.click(switches[2])

    const apiFetch = vi.mocked(api.apiFetch)
    await user.click(await screen.findByRole('button', { name: 'Save changes' }))
    const putCall = await waitForPut(apiFetch)
    const body = JSON.parse((putCall?.[1]?.body as string) ?? '{}')
    const providers = (body as { providers: { id: number; enabled: boolean }[] }).providers
    expect(providers.find(p => p.id === 3)?.enabled).toBe(false)
  })

  it('discards local edits and restores the server default family', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi()
    renderPage()

    await screen.findByText('bge-m3', { selector: 'a' })
    await user.click(screen.getByRole('button', { name: 'Make default' }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Discard' }))

    // localDefault resets: text-embedding-3 is default again, so the only
    // "Make default" affordance is back on bge-m3 and no PUT was ever sent.
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1)
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/embeddings',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('renders an empty state when there are no families', async () => {
    mockApi({ embeddings: { defaultFamily: '', families: [] } })
    renderPage()
    await screen.findByText('Embeddings')
    // No family sections render, no edit bar.
    expect(screen.queryByText('Make default')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
})

function waitForPut(apiFetch: ReturnType<typeof vi.mocked<typeof api.apiFetch>>) {
  return waitFor(() => {
    const call = apiFetch.mock.calls.find(c => c[0] === '/api/embeddings' && c[1]?.method === 'PUT')
    expect(call).toBeTruthy()
    return call
  })
}