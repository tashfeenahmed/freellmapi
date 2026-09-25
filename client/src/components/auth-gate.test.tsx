// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AuthGate } from '@/components/auth-gate'
import * as api from '@/lib/api'

// AuthGate gates the whole dashboard on /api/auth/status. These tests drive
// each branch: loading, server unreachable, needsSetup (setup form), not
// authenticated (login form), and authenticated (children render).

function renderGate(children = <div>dashboard content</div>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AuthGate>{children}</AuthGate>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

function mockAuthStatus(status: {
  needsSetup: boolean
  authenticated: boolean
  email?: string | null
  token?: string
}) {
  return vi.spyOn(api, 'apiFetch').mockResolvedValue(status as never)
}

describe('AuthGate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the loading state while the status query is in flight', () => {
    // Never-resolving promise keeps isLoading true.
    vi.spyOn(api, 'apiFetch').mockImplementation(
      () => new Promise(() => {}) as never,
    )
    renderGate()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows the server-unreachable error when the status request fails', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new Error('boom') as never)
    renderGate()
    expect(await screen.findByText(/can't reach the server/i)).toBeInTheDocument()
  })

  it('renders the setup form when needsSetup is true', async () => {
    mockAuthStatus({ needsSetup: true, authenticated: false, email: null })
    renderGate()
    expect(await screen.findByText('Create your account')).toBeInTheDocument()
    // Setup form has a new-password autocomplete.
    const password = await screen.findByLabelText('Password')
    expect(password).toHaveAttribute('autoComplete', 'new-password')
  })

  it('renders the login form when not authenticated', async () => {
    mockAuthStatus({ needsSetup: false, authenticated: false, email: null })
    renderGate()
    // "Sign in" appears both as the heading and the submit button.
    expect(await screen.findAllByText('Sign in')).not.toHaveLength(0)
    const password = await screen.findByLabelText('Password')
    expect(password).toHaveAttribute('autoComplete', 'current-password')
  })

  it('renders children when authenticated', async () => {
    mockAuthStatus({ needsSetup: false, authenticated: true, email: 'dev@example.com' })
    renderGate()
    expect(await screen.findByText('dashboard content')).toBeInTheDocument()
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument()
  })

  it('submits the login form and refetches status on success', async () => {
    const user = userEvent.setup()
    const apiFetch = mockAuthStatus({
      needsSetup: false,
      authenticated: false,
      email: null,
      token: 'test-token',
    })
    const setToken = vi.spyOn(api, 'setToken').mockImplementation(() => {})
    renderGate()

    await user.type(await screen.findByLabelText('Email'), 'dev@example.com')
    await user.type(screen.getByLabelText('Password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
      expect(setToken).toHaveBeenCalledWith(expect.any(String))
    })
  })

  it('refetches status when the UNAUTHORIZED_EVENT fires', async () => {
    const apiFetch = mockAuthStatus({ needsSetup: false, authenticated: true, email: 'dev@example.com' })
    renderGate()
    await screen.findByText('dashboard content')

    // A 401 elsewhere clears the token and dispatches the event — AuthGate
    // should re-query so the login form appears.
    apiFetch.mockResolvedValue({ needsSetup: false, authenticated: false, email: null } as never)
    window.dispatchEvent(new Event(api.UNAUTHORIZED_EVENT))

    expect(await screen.findAllByText('Sign in')).not.toHaveLength(0)
  })
})
