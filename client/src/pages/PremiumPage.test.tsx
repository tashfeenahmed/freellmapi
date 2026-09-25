// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import PremiumPage from '@/pages/PremiumPage'
import * as api from '@/lib/api'

// PremiumPage shows the live-vs-snapshot catalog state, the device license
// (activate / remove / manage), and an upsell when unlicensed.
// These tests drive the loading / no-key / licensed / expired branches plus
// the sync + portal mutations.

type PremiumStatus = {
  hasKey: boolean
  maskedKey: string | null
  license: {
    valid: boolean
    plan: 'annual' | 'lifetime' | null
    status: string | null
    expiresAt: string | null
    cancelAtPeriodEnd?: boolean
    reason?: string
    checkedAtMs: number
  } | null
  catalog: { baseUrl: string; appliedVersion: string | null; appliedTier: string | null; lastSyncMs: number | null; lastError: string | null }
  siteUrl: string
}

const baseCatalog = {
  baseUrl: 'https://models.llmpipe.app',
  appliedVersion: '2026.08.1',
  appliedTier: 'live' as const,
  lastSyncMs: 1_720_000_000_000,
  lastError: null as string | null,
}

function status(overrides: Partial<PremiumStatus> = {}): PremiumStatus {
  return {
    hasKey: true,
    maskedKey: 'fla_••••••••••••••••',
    license: { valid: true, plan: 'annual', status: 'active', expiresAt: null, checkedAtMs: 1_720_000_000_000 },
    catalog: { ...baseCatalog },
    siteUrl: 'https://llmpipe.app',
    ...overrides,
  }
}

function mockApi(statusOverride: Partial<PremiumStatus> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/api/premium') return status(statusOverride) as never
    if (path === '/api/premium/portal') return { url: 'https://llmpipe.app/portal' } as never
    return {} as never
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter>
          <PremiumPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('PremiumPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading skeleton while the query is in flight', () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(() => new Promise(() => {}) as never)
    const { container } = renderPage()
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
  })

  it('renders live feed catalog state with version and last-sync time', async () => {
    mockApi()
    renderPage()

    expect(await screen.findByText('Live feed')).toBeInTheDocument()
    expect(screen.getByText('2026.08.1')).toBeInTheDocument()
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
    expect(screen.getByText(/within hours of being shipped/)).toBeInTheDocument()
  })

  it('renders the monthly snapshot state when the tier is not live', async () => {
    mockApi({
      catalog: { ...baseCatalog, appliedVersion: null, appliedTier: 'snapshot', lastSyncMs: null },
    })
    renderPage()

    expect(await screen.findByText('Monthly snapshot')).toBeInTheDocument()
    expect(screen.getByText('bundled')).toBeInTheDocument()
    expect(screen.getByText(/last checked: never/i)).toBeInTheDocument()
  })

  it('surfaces a previous sync error', async () => {
    mockApi({ catalog: { ...baseCatalog, lastError: '402 retry after 12h' } })
    renderPage()
    expect(await screen.findByText(/last sync problem: 402 retry after 12h/i)).toBeInTheDocument()
  })

  it('shows an annual license badge with the masked key and no upsell', async () => {
    mockApi({ license: { valid: true, plan: 'annual', status: 'active', expiresAt: '2027-02-01T00:00:00.000Z', checkedAtMs: 1_720_000_000_000 } })
    renderPage()

    await screen.findByText('fla_••••••••••••••••')
    expect(screen.getByText('Premium Annual')).toBeInTheDocument()
    expect(screen.getByText(/renews on/i)).toBeInTheDocument()
    expect(screen.queryByText(/go live for \$19 a year/i)).not.toBeInTheDocument()
  })

  it('shows a lifetime badge with the lifetime note', async () => {
    mockApi({ license: { valid: true, plan: 'lifetime', status: 'active', expiresAt: null, checkedAtMs: 1_720_000_000_000 } })
    renderPage()

    await screen.findByText('Premium Lifetime')
    expect(screen.getByText(/never expires/i)).toBeInTheDocument()
  })

  it('marks an expired license and shows the upsell', async () => {
    mockApi({ license: { valid: false, plan: 'annual', status: 'expired', expiresAt: null, reason: 'expired', checkedAtMs: 1_720_000_000_000 } })
    renderPage()

    await screen.findByText('Expired')
    expect(screen.getByText(/no longer active/i)).toBeInTheDocument()
    expect(screen.getByText(/go live for \$19 a year/i)).toBeInTheDocument()
  })

  it('lets the user reveal the activation form when no key is stored', async () => {
    mockApi({ hasKey: false, maskedKey: null, license: null })
    renderPage()

    const input = await screen.findByPlaceholderText('fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    expect(input).toBeInTheDocument()
    expect(screen.getByText(/recover it on the website/i)).toBeInTheDocument()
    // Upsell shows for the unlicensed state.
    expect(screen.getByText(/go live for \$19 a year/i)).toBeInTheDocument()
  })

  it('activates a license key via POST /api/premium/key', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi({ hasKey: false, maskedKey: null, license: null })
    renderPage()

    const input = await screen.findByPlaceholderText('fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    await user.type(input, 'fla_TESTKEY123')
    await user.click(screen.getByRole('button', { name: 'Activate' }))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/premium/key',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const postCall = apiFetch.mock.calls.find(c => c[0] === '/api/premium/key' && c[1]?.method === 'POST')
    const body = JSON.parse((postCall?.[1]?.body as string) ?? '{}')
    expect(body).toEqual({ key: 'fla_TESTKEY123' })
  })

  it('does not activate an empty key', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi({ hasKey: false, maskedKey: null, license: null })
    renderPage()

    await screen.findByPlaceholderText('fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
    // An empty submit is rejected client-side: inline validation error, no POST.
    await user.click(screen.getByRole('button', { name: 'Activate' }))
    expect(await screen.findByText('Required')).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/premium/key',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('removes the key via DELETE /api/premium/key', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi()
    renderPage()

    await screen.findByText('fla_••••••••••••••••')
    await user.click(screen.getByRole('button', { name: 'Remove key from this device' }))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/premium/key', expect.objectContaining({ method: 'DELETE' }))
    })
  })

  it('triggers a catalog sync via POST /api/premium/sync', async () => {
    const user = userEvent.setup()
    const apiFetch = mockApi()
    renderPage()

    await screen.findByText('Live feed')
    await user.click(screen.getByRole('button', { name: 'Check for updates' }))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/premium/sync', expect.objectContaining({ method: 'POST' }))
    })
  })

  it('opens the billing portal in a new window', async () => {
    const user = userEvent.setup()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    mockApi()
    renderPage()

    await screen.findByText('fla_••••••••••••••••')
    await user.click(screen.getByRole('button', { name: 'Manage subscription' }))

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('https://llmpipe.app/portal', '_blank', 'noopener')
    })
  })
})