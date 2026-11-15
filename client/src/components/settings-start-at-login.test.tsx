// @vitest-environment jsdom
// The "Start on system startup" row in the Settings dialog's General section:
// it only appears inside a desktop build (the __FREEAPI_LOGIN_ITEM__ bridge),
// reads the OS flag on open, and calls back into the shell when toggled.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { ThemeProvider } from '@/theme'
import { SettingsDialog } from './settings-dialog'

let root: Root
let container: HTMLDivElement
let bridge: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  bridge = { get: vi.fn(async () => true), set: vi.fn(async () => {}) }
  ;(window as { __FREEAPI_LOGIN_ITEM__?: typeof bridge }).__FREEAPI_LOGIN_ITEM__ = bridge
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  delete (window as { __FREEAPI_LOGIN_ITEM__?: unknown }).__FREEAPI_LOGIN_ITEM__
  container.remove(); document.body.innerHTML = ''
})

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function render() {
  act(() => root.render(
    <ThemeProvider>
      <I18nProvider initialLocale="en">
        <SettingsDialog open onOpenChange={() => {}} />
      </I18nProvider>
    </ThemeProvider>,
  ))
  await flush()
}

const switchLabel = () => [...document.querySelectorAll('[data-slot="switch"]')] as HTMLButtonElement[]

describe('settings dialog — start on system startup', () => {
  it('renders the row only when the desktop login-item bridge is present', async () => {
    await render()
    expect(switchLabel().length).toBe(1)
    expect(switchLabel()[0].getAttribute('aria-label')).toBe('Start on system startup')
    expect(bridge.get).toHaveBeenCalledTimes(1)
  })

  it('hides the row in a plain browser (no bridge)', async () => {
    delete (window as { __FREEAPI_LOGIN_ITEM__?: unknown }).__FREEAPI_LOGIN_ITEM__
    await render()
    expect(switchLabel().length).toBe(0)
    expect(bridge.get).not.toHaveBeenCalled()
  })

  it('calls the shell to set the flag when toggled on', async () => {
    bridge.get.mockResolvedValue(false)
    await render()
    const toggle = switchLabel()[0]
    expect(toggle.hasAttribute('data-checked')).toBe(false)
    await act(async () => { toggle.click() })
    expect(bridge.set).toHaveBeenCalledWith(true)
    expect(toggle.hasAttribute('data-checked')).toBe(true)
  })

  it('restores the previous state when the shell rejects the change', async () => {
    await render()
    bridge.set.mockRejectedValueOnce(new Error('nope'))
    const toggle = switchLabel()[0]
    await act(async () => { toggle.click() })
    // Optimistic flip then rollback to the last known true.
    expect(toggle.hasAttribute('data-checked')).toBe(true)
  })
})
