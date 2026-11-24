// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { clearToken, getToken } from '@/lib/api'
import { AuthGate } from './auth-gate'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  clearToken()
  window.history.replaceState(null, '', '/')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  clearToken()
  window.history.replaceState(null, '', '/')
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function waitFor(assertion: () => void, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    try {
      assertion()
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AuthGate><div data-testid="app">Dashboard</div></AuthGate>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
}

describe('AuthGate OIDC sign-in (#2008)', () => {
  it('shows the SSO button alongside email login and hides the password form when disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/auth/status')) {
        return json({
          needsSetup: false,
          authenticated: false,
          email: null,
          oidc: { enabled: true, providerName: 'Authentik', passwordLoginDisabled: false, autoRedirect: false, canAutoProvision: true },
        })
      }
      return json({}, 404)
    }))

    mount()
    await waitFor(() => {
      expect(container.textContent).toContain('Sign in with Authentik')
      expect(container.querySelector('#auth-email')).not.toBeNull()
    })

    // Now test passwordLoginDisabled=true
    act(() => root.unmount())
    root = createRoot(container)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/status')) {
        return json({
          needsSetup: false,
          authenticated: false,
          email: null,
          oidc: { enabled: true, providerName: 'Pocket ID', passwordLoginDisabled: true, autoRedirect: false, canAutoProvision: true },
        })
      }
      return json({}, 404)
    }))
    mount()
    await waitFor(() => {
      expect(container.textContent).toContain('Sign in with Pocket ID')
      expect(container.querySelector('#auth-email')).toBeNull()
    })
  })

  it('exchanges #oidc_code from the URL fragment, strips it, and renders the dashboard', async () => {
    window.history.replaceState(null, '', '/#oidc_code=one-time-code-123')
    let authed = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/auth/oidc/exchange')) {
        expect(JSON.parse(String(init?.body))).toEqual({ code: 'one-time-code-123' })
        authed = true
        return json({ token: 'oidc-session-token', email: 'admin@example.com' })
      }
      if (url.endsWith('/api/auth/status')) {
        return json({
          needsSetup: false,
          authenticated: authed,
          email: authed ? 'admin@example.com' : null,
          authSource: authed ? 'oidc' : undefined,
          hasLocalPassword: authed ? false : undefined,
        })
      }
      return json({}, 404)
    }))

    mount()
    await waitFor(() => {
      expect(window.location.hash).toBe('')
      expect(getToken()).toBe('oidc-session-token')
      expect(container.querySelector('[data-testid="app"]')?.textContent).toBe('Dashboard')
    })
  })

  it('displays a localized error when #oidc_error arrives', async () => {
    window.history.replaceState(null, '', '/#oidc_error=not_allowed')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/status')) {
        return json({
          needsSetup: false,
          authenticated: false,
          email: null,
          oidc: { enabled: true, providerName: 'Authelia', passwordLoginDisabled: true, autoRedirect: false, canAutoProvision: true },
        })
      }
      return json({}, 404)
    }))

    mount()
    await waitFor(() => {
      expect(window.location.hash).toBe('')
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('not permitted')
    })
  })
})
