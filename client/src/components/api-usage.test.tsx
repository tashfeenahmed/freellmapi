import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/i18n'
import { ApiUsageBlock, apiBaseUrl } from '@/components/api-usage'

// api-usage renders a copy-able "ways to use the API" snippet card. The pure
// apiBaseUrl() helper derives the /v1 base URL from the dev-server port or the
// page origin.

describe('apiBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses the dev-server port when running in DEV mode', () => {
    vi.stubEnv('DEV', true)
    Object.defineProperty(window, 'location', {
      value: { hostname: 'localhost', origin: 'http://localhost:5173' },
      writable: true,
    })
    // __SERVER_PORT__ is a Vite define (defaults to 3001); assert it is a
    // non-empty string injected into the bundle.
    expect(apiBaseUrl()).toMatch(/^http:\/\/localhost:\d+\/v1$/)
  })

  it('uses the page origin in a packaged/hosted build', () => {
    vi.stubEnv('DEV', false)
    Object.defineProperty(window, 'location', {
      value: { hostname: 'app.example.com', origin: 'https://app.example.com' },
      writable: true,
    })
    expect(apiBaseUrl()).toBe('https://app.example.com/v1')
  })
})

describe('ApiUsageBlock', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the snippet and a copy button', () => {
    Object.assign(navigator, { clipboard: { writeText: writeText } })
    render(
      <I18nProvider>
        <ApiUsageBlock snippet={'curl http://localhost:3001/v1/chat'} />
      </I18nProvider>,
    )
    expect(screen.getByText('curl http://localhost:3001/v1/chat')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument()
  })

  it('copies the snippet text on click', () => {
    Object.assign(navigator, { clipboard: { writeText: writeText } })
    render(
      <I18nProvider>
        <ApiUsageBlock snippet="hello" />
      </I18nProvider>,
    )
    screen.getByRole('button', { name: /copy/i }).click()
    expect(writeText).toHaveBeenCalledWith('hello')
  })
})
