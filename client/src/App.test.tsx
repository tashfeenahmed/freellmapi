// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import App from '@/App'
import { installApiFetchMock } from '@/test/api-mock'

// Smoke test: the main dashboard mounts and renders its shell (brand + nav)
// without crashing. App already wraps itself in <BrowserRouter>, so we only
// supply the providers it expects. AuthGate + data queries use the apiFetch mock.
function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <App />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('App dashboard smoke', () => {
  beforeEach(() => {
    installApiFetchMock()
  })

  it('renders the brand and primary navigation', async () => {
    renderApp()
    // Brand wordmark from the navbar.
    expect(await screen.findByText('FreeLLMAPI')).toBeInTheDocument()
    // A primary nav destination should be present once the shell paints.
    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeInTheDocument()
    })
  })

  it('does not throw while mounting with a mocked authenticated session', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderApp()
    // Give React a tick to run effects/queries.
    await screen.findByText('FreeLLMAPI')
    // No React render errors should have been logged.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
