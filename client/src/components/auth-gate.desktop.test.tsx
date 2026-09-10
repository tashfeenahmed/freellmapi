// @vitest-environment jsdom
//
// The desktop shell signs the dashboard in as a hidden machine account whose
// password is random and never shown (desktop/src/server-host.ts). If that
// session is ever rejected — expired after a month of uptime, cleared by a
// 401 — the gate must ask the shell for a fresh one, never show a login form
// nobody can fill in. This mounts the real AuthGate against a stubbed
// /api/auth/status and checks exactly that.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AuthGate } from './auth-gate'

type DesktopWindow = Window & {
  __FREEAPI_DESKTOP__?: boolean
  __FREEAPI_SESSION__?: () => Promise<string>
}

const FRESH = 'fresh-session-token'
const TOKEN_KEY = 'freellmapi_dashboard_token'

let root: Root
let container: HTMLDivElement
let accepted: Set<string>
let statusCalls: string[]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AuthGate><div data-testid="app">dashboard</div></AuthGate>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  accepted = new Set()
  statusCalls = []
  localStorage.setItem(TOKEN_KEY, 'stale-token')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith('/api/auth/status')) return json({ error: { message: `unexpected ${url}` } }, 404)
    const auth = new Headers(init?.headers).get('Authorization') ?? ''
    statusCalls.push(auth)
    const ok = accepted.has(auth.replace(/^Bearer /, ''))
    return json({ needsSetup: false, authenticated: ok, email: ok ? 'desktop@localhost' : null })
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
  const w = window as DesktopWindow
  delete w.__FREEAPI_DESKTOP__
  delete w.__FREEAPI_SESSION__
})

const passwordField = () => container.querySelector('input[type="password"]')

describe('AuthGate inside the desktop shell', () => {
  it('replaces a rejected session through the shell and never shows the login form', async () => {
    const w = window as DesktopWindow
    w.__FREEAPI_DESKTOP__ = true
    const bridge = vi.fn(async () => {
      accepted.add(FRESH)
      return FRESH
    })
    w.__FREEAPI_SESSION__ = bridge

    mount()
    await flush()

    expect(bridge).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(TOKEN_KEY)).toBe(FRESH)
    expect(statusCalls.at(-1)).toBe(`Bearer ${FRESH}`)
    expect(container.querySelector('[data-testid="app"]')?.textContent).toBe('dashboard')
    expect(passwordField()).toBeNull()
  })

  it('shows the recovery message, not a password prompt, when the fresh session is rejected too', async () => {
    const w = window as DesktopWindow
    w.__FREEAPI_DESKTOP__ = true
    const bridge = vi.fn(async () => 'still-rejected')
    w.__FREEAPI_SESSION__ = bridge

    mount()
    await flush()

    expect(bridge).toHaveBeenCalledTimes(1)
    expect(passwordField()).toBeNull()
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
    expect(container.textContent).toContain('Quit FreeLLMAPI and open it again')
  })

  // The recovery message is the whole screen: a screen reader that has already
  // announced "loading" must be told the wait ended in a failure.
  it('announces the recovery message as an alert', async () => {
    const w = window as DesktopWindow
    w.__FREEAPI_DESKTOP__ = true
    w.__FREEAPI_SESSION__ = vi.fn(async () => 'still-rejected')

    mount()
    await flush()

    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent?.trim()).not.toBe('')
  })
})

describe('AuthGate in a browser', () => {
  it('still shows the sign-in form when the session is rejected', async () => {
    mount()
    await flush()

    expect(passwordField()).not.toBeNull()
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
  })

  // Assertions are on the wiring, not the wording: the copy comes from t() and
  // is free to change, but a validation error nobody's input points at is
  // silent to a screen reader.
  it('ties each validation error to the field it describes', async () => {
    mount()
    await flush()

    const form = container.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    for (const id of ['auth-email', 'auth-password']) {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!
      const describedBy = input.getAttribute('aria-describedby')
      expect(describedBy).not.toBeNull()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      const error = container.querySelector(`#${describedBy}`)!
      expect(error).not.toBeNull()
      expect(error.getAttribute('role')).toBe('alert')
      expect(error.textContent?.trim()).not.toBe('')
    }
  })

  it('gives every field a label pointing at it', async () => {
    mount()
    await flush()

    const inputs = [...container.querySelectorAll('input')]
    expect(inputs.length).toBeGreaterThan(0)
    for (const input of inputs) {
      expect(input.id).not.toBe('')
      const label = container.querySelector(`label[for="${input.id}"]`)
      expect(label, `no label for #${input.id}`).not.toBeNull()
      expect(label?.textContent?.trim()).not.toBe('')
    }
  })
})
