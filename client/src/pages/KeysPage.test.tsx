// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import KeysPage from '@/pages/KeysPage'
import { installApiFetchMock } from '@/test/api-mock'

// Smoke test: the Keys page (the "key list" surface) mounts, fetches keys via
// the mocked apiFetch, and renders at least one platform row.
function renderKeysPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter>
          <KeysPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('KeysPage smoke (key list)', () => {
  beforeEach(() => {
    installApiFetchMock()
  })

  it('renders the unified key section', async () => {
    const user = userEvent.setup()
    renderKeysPage()
    // The unified key section lives on the "Unified API key" tab; the page
    // defaults to the provider list.
    await user.click(await screen.findByRole('tab', { name: 'Unified API key' }))
    // The section renders the unified key value + base URL endpoints.
    expect((await screen.findAllByText(/api_key|baseUrl|endpoint/i)).length).toBeGreaterThan(0)
  })

  it('renders at least one key row from the mocked api response', async () => {
    renderKeysPage()
    // The mock returns two keys; at least one platform label should appear.
    await waitFor(() => {
      const rows = screen.getAllByText(/google|groq/i)
      expect(rows.length).toBeGreaterThan(0)
    })
  })
})
