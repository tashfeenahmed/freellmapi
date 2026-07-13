import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
    renderKeysPage()
    // The unified key section always renders (key value + base URL endpoints).
    expect(await screen.findByText(/api_key|baseUrl|endpoint/i)).toBeTruthy()
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
