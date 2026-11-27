// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/theme'
import { SettingsDialog } from './settings-dialog'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  container.remove()
  document.body.innerHTML = ''
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function waitFor(assertion: () => void, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    try {
      assertion()
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

describe('SettingsDialog — system date injection (#1931)', () => {
  it('loads the saved mode, updates via PUT /api/settings/system-date, and rolls back on failure', async () => {
    let savedMode = 'web_search'
    let failNextPut = false
    const putCalls: unknown[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/settings/system-date')) {
        if (init?.method === 'PUT') {
          const parsed = JSON.parse(String(init.body))
          putCalls.push(parsed)
          if (failNextPut) {
            failNextPut = false
            return json({ error: { message: 'boom' } }, 500)
          }
          savedMode = parsed.mode
          return json({ mode: savedMode })
        }
        return json({ mode: savedMode })
      }
      return json({}, 200)
    }))

    act(() => root.render(
      <ThemeProvider>
        <I18nProvider initialLocale="en">
          <SettingsDialog open onOpenChange={() => {}} />
        </I18nProvider>
      </ThemeProvider>,
    ))

    const group = () => document.querySelector('[role="radiogroup"][aria-label="System date in prompt"]')!
    const radio = (label: string) =>
      [...group().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find(btn => btn.textContent?.trim() === label)!

    await waitFor(() => {
      expect(group()).not.toBeNull()
      expect(radio('Web search').getAttribute('aria-checked')).toBe('true')
    })

    await act(async () => { radio('Always').click() })
    await waitFor(() => {
      expect(putCalls).toEqual([{ mode: 'always' }])
      expect(radio('Always').getAttribute('aria-checked')).toBe('true')
    })

    // Rollback on PUT error
    failNextPut = true
    await act(async () => { radio('Off').click() })
    await waitFor(() => {
      expect(putCalls).toHaveLength(2)
      expect(radio('Always').getAttribute('aria-checked')).toBe('true')
    })
  })
})
