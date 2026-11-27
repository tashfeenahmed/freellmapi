// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import type { DesktopUpdateState } from '@/lib/desktop-updater'
import { UpdatesDialog } from './updates-dialog'

const current: DesktopUpdateState = { phase: 'current', checkedAt: '2026-11-23T00:00:00Z' }
const unsupported: DesktopUpdateState = { phase: 'unsupported', reason: 'package' }
const shell = window as Window & { __FREEAPI_UPDATER__?: unknown }
let root: Root
let container: HTMLDivElement
let updateResponse: Response
let fetchMock: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  updateResponse = Response.json({ installation: 'desktop', status: 'available', version: '0.16.37' })
  fetchMock = vi.fn(async (url) => {
    if (url === '/api/update/check') return updateResponse
    if (url === '/api/settings/version') return Response.json({ version: '0.16.37' })
    if (url === '/api/settings/update-check') return Response.json({ enabled: true })
    throw new Error(`Unexpected request to ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete shell.__FREEAPI_UPDATER__
  vi.unstubAllGlobals()
})

async function render(state: DesktopUpdateState) {
  shell.__FREEAPI_UPDATER__ = {
    state: async () => state,
    check: async () => state,
    subscribe: () => () => {},
  }
  await act(async () => {
    root.render(<I18nProvider initialLocale="en"><UpdatesDialog open onOpenChange={() => {}} /></I18nProvider>)
  })
}

describe('desktop update checks', () => {
  it('checks the server and links to releases when the package cannot update itself', async () => {
    await render(unsupported)
    expect(fetchMock).toHaveBeenCalledWith('/api/update/check', expect.any(Object))
    expect(document.body.textContent).toContain('Update available')
    expect(document.querySelector('a[href="https://github.com/tashfeenahmed/freellmapi/releases/latest"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Checking…')
  })

  it('offers a retry when the server update check fails', async () => {
    updateResponse = Response.json({ error: { message: 'GitHub unavailable' } }, { status: 502 })
    await render(unsupported)
    expect(document.body.textContent).toContain('Could not check for updates.')
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Try again')
    expect(retry).toBeDefined()

    updateResponse = Response.json({ installation: 'desktop', status: 'current', version: '0.16.37' })
    await act(async () => { retry?.click() })
    expect(document.body.textContent).toContain('Up to date')
  })

  it('uses only the native updater when the package supports it', async () => {
    await render(current)
    expect(document.body.textContent).toContain('Up to date')
    expect(fetchMock).not.toHaveBeenCalledWith('/api/update/check', expect.any(Object))
  })
})
