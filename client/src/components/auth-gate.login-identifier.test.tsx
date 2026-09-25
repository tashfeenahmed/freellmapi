// @vitest-environment jsdom
//
// The desktop app seeds a hidden account named `desktop@localhost`. The login
// route accepts that identifier on purpose, but the form used to reject it
// client-side ("Enter a valid email address") before any request was sent, so
// a desktop user who opened the dashboard in a browser could reset the
// password and still never sign in (#1250). Setup keeps the strict check.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AuthGate } from './auth-gate'

let root: Root
let container: HTMLDivElement
let needsSetup: boolean
let posts: { url: string; body: Record<string, string> }[]

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

function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit() {
  const form = container.querySelector('form')!
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  needsSetup = false
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/auth/status')) return json({ needsSetup, authenticated: false, email: null })
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return json({ error: { message: 'Invalid email or password' } }, 401)
    }
    return json({ error: { message: `unexpected ${url}` } }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('AuthGate login identifier', () => {
  it('sends the desktop account identifier to the login route instead of blocking it', async () => {
    mount()
    await flush()
    type('#auth-email', 'desktop@localhost')
    type('#auth-password', 'a-new-password')
    await submit()

    expect(posts).toHaveLength(1)
    expect(posts[0].url.endsWith('/api/auth/login')).toBe(true)
    expect(posts[0].body.email).toBe('desktop@localhost')
    expect(container.querySelector('#auth-email-error')).toBeNull()
  })

  it('still requires something in the email field on login', async () => {
    mount()
    await flush()
    type('#auth-password', 'a-new-password')
    await submit()

    expect(posts).toHaveLength(0)
    expect(container.querySelector('#auth-email-error')).not.toBeNull()
  })

  it('keeps the strict email check when creating the first account', async () => {
    needsSetup = true
    mount()
    await flush()
    type('#auth-email', 'desktop@localhost')
    type('#auth-password', 'a-long-enough-password')
    await submit()

    expect(posts).toHaveLength(0)
    expect(container.querySelector('#auth-email-error')?.textContent).toContain('valid email')
  })
})
