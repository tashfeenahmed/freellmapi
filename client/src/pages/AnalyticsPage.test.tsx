import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import AnalyticsPage from '@/pages/AnalyticsPage'
import * as api from '@/lib/api'

// AnalyticsPage renders six range-scoped queries into stat cards, charts and
// tables. The charts (recharts) don't measure layout in jsdom, so this
// focuses on the non-chart surface: stat cards, the savings-projection hint,
// the pinned-request hint, range switching, and the per-model / error tables.

let lastSeenRanges: string[] = []

const DAY_MS = 86_400_000

// SQLite-style UTC stamp, for values the page parses via formatSqliteUtcToIso.
function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function summaryFor(range: string, firstRequestAtMs?: number) {
  return {
    totalRequests: 20,
    successRate: 92.5,
    totalInputTokens: 1_850_000,
    totalOutputTokens: 88_000,
    avgLatencyMs: 812,
    estimatedCostSavings: range === '30d' ? 10 : 2,
    // Default: 2 days of history → extrapolated projection (30/2 = 15x).
    firstRequestAt: sqliteStamp(firstRequestAtMs ?? Date.now() - 2 * DAY_MS),
    pinnedRequests: 5,
    pinHonoredRequests: 4,
  }
}

const platformRows = [
  { platform: 'nvidia', requests: 12, avgLatencyMs: 900 },
  { platform: 'openai', requests: 8, avgLatencyMs: 700 },
]

const timelineRows = [
  { timestamp: '2026-08-17 09:00:00', successCount: 5, failureCount: 1 },
]

const modelRows = [
  {
    displayName: 'nvidia/llama-3.3-70b',
    platform: 'nvidia',
    requests: 12,
    pinnedRequests: 3,
    successRate: 91.7,
    avgLatencyMs: 900,
    totalInputTokens: 1_250_000,
    totalOutputTokens: 42_000,
    estimatedCost: 1.23,
  },
]

const errorRows = [
  { id: 1, platform: 'nvidia', error: 'rate limited', createdAt: '2026-08-17 09:00:00' },
]

function installMock() {
  lastSeenRanges = []
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    const match = path.match(/range=(\w+)/)
    if (match) lastSeenRanges.push(match[1])
    if (path.includes('error-distribution')) return { byCategory: [], byPlatform: [], detailed: [] } as never
    if (path.includes('summary')) return summaryFor(match?.[1] ?? '7d') as never
    if (path.includes('by-platform')) return platformRows as never
    if (path.includes('timeline')) return timelineRows as never
    if (path.includes('by-model')) return modelRows as never
    if (path.includes('errors')) return errorRows as never
    return {} as never
  })
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AnalyticsPage />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

// jsdom has no ResizeObserver (recharts ResponsiveContainer uses it). A no-op
// stub lets the component mount; charts render without measuring.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  it('renders summary stat cards from the 7d range query', async () => {
    installMock()
    renderPage()

    // The stat-card label is the <p> inside the Stat card (the table also
    // has a "Requests" column header).
    expect(await screen.findByText('Requests', { selector: 'p' })).toBeInTheDocument()
    expect(await screen.findByText('20')).toBeInTheDocument() // totalRequests
    expect(screen.getByText('92.5%')).toBeInTheDocument() // successRate
    expect(screen.getByText('1.9M')).toBeInTheDocument() // 1,850,000 input tokens
    expect(screen.getByText('88.0K')).toBeInTheDocument() // 88,000 output tokens
    expect(screen.getByText('812 ms')).toBeInTheDocument()
    await waitFor(() => expect(lastSeenRanges).toContain('7d'))
  })

  it('projects savings to a full month when data spans fewer than 30 days', async () => {
    installMock()
    renderPage()

    // 30d summary: 2 days of history → factor 30/2 = 15 → 10 * 15 = $150.00.
    expect(await screen.findByText('$150.00')).toBeInTheDocument()
    // The hover hint on the est-savings card names the projection basis.
    await userEvent.hover(screen.getByText('Est. savings'))
    expect(await screen.findByText(/projects your pace/)).toBeInTheDocument()
  })

  it('shows the exact savings when 30+ days of history exist', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      const match = path.match(/range=(\w+)/)
      if (match) lastSeenRanges.push(match[1])
      if (path.includes('error-distribution')) return { byCategory: [], byPlatform: [], detailed: [] } as never
      if (path.includes('summary')) {
        // 60 days of history → real 30-day total (no extrapolation).
        return summaryFor(match?.[1] ?? '7d', Date.now() - 60 * DAY_MS) as never
      }
      if (path.includes('by-platform')) return platformRows as never
      if (path.includes('timeline')) return timelineRows as never
      if (path.includes('by-model')) return modelRows as never
      if (path.includes('errors')) return errorRows as never
      return {} as never
    })
    renderPage()

    expect(await screen.findByText('$10.00')).toBeInTheDocument()
    await userEvent.hover(screen.getByText('Est. savings'))
    expect(await screen.findByText(/real 30-day total/)).toBeInTheDocument()
  })

  it('describes pinned vs auto-routed requests in the requests hint', async () => {
    installMock()
    renderPage()

    await screen.findByText('20')
    await userEvent.hover(screen.getByText('Requests', { selector: 'p' }))
    // pinnedRequests=5, pinHonoredRequests=4 → pinned hint text.
    expect(await screen.findByText(/of these requests pinned a specific model/)).toBeInTheDocument()
  })

  it('switches the time range with the segmented buttons and refetches', async () => {
    const user = userEvent.setup()
    installMock()
    renderPage()

    await screen.findByText('20')
    await user.click(screen.getByRole('button', { name: '24h' }))
    await waitFor(() => expect(lastSeenRanges).toContain('24h'))
  })

  it('renders the per-model breakdown table with formatted values', async () => {
    installMock()
    renderPage()

    expect(await screen.findByText('nvidia/llama-3.3-70b')).toBeInTheDocument()
    expect(screen.getByText('1.3M')).toBeInTheDocument() // 1,250,000 in tokens
    expect(screen.getByText('42.0K')).toBeInTheDocument() // 42,000 out tokens
    expect(screen.getByText('3')).toBeInTheDocument() // pinned requests column
    expect(screen.getByText('$1.23')).toBeInTheDocument() // estimated cost
  })

  it('renders recent errors with the local-time formatted column', async () => {
    installMock()
    renderPage()

    expect(await screen.findByText('rate limited')).toBeInTheDocument()
    // Time column: formatSqliteUtcToLocalTime renders a time-of-day string.
    expect(screen.getByText(/\d{1,2}:\d{2}(:\d{2})?/)).toBeInTheDocument()
  })

  it('shows no-data placeholders when queries return empty lists', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path.includes('summary')) return summaryFor('7d') as never
      return [] as never
    })
    renderPage()

    const noData = await screen.findAllByText('No data yet')
    expect(noData.length).toBeGreaterThanOrEqual(3)
    // "No errors" appears in both the error-distribution and recent-errors panels.
    expect(screen.getAllByText('No errors').length).toBeGreaterThanOrEqual(1)
  })
})