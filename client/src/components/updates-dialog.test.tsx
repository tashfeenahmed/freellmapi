// @vitest-environment jsdom
// M37: the desktop preload always exposes the updater bridge, but a build that
// cannot replace itself (dev, portable zip, deb/rpm) reports `unsupported`.
// The dialog used to skip the server check whenever the bridge existed, so on
// those builds it spun "Checking…" forever. It now asks the server instead.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { DesktopUpdateState } from '@/lib/desktop-updater'
import { UpdatesDialog } from './updates-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

type Win = Window & { __FREEAPI_UPDATER__?: unknown }

let root: Root
let container: HTMLDivElement

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/update/check') return { status: 'current', installation: 'desktop', localSha: null, version: '0.15.0' }
    if (path === '/api/settings/update-check') return { enabled: true }
    if (path === '/api/settings/version') return { version: '0.15.0' }
    return {}
  })
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  delete (window as Win).__FREEAPI_UPDATER__
})

function installBridge(state: () => Promise<DesktopUpdateState>) {
  const bridge = {
    state: vi.fn(state),
    check: vi.fn(state),
    download: vi.fn(state),
    install: vi.fn(state),
    subscribe: vi.fn(() => () => {}),
  }
  ;(window as Win).__FREEAPI_UPDATER__ = bridge
  return bridge
}

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function mount() {
  act(() => root.render(
    <I18nProvider initialLocale="en"><UpdatesDialog open onOpenChange={() => {}} /></I18nProvider>,
  ))
  await flush()
}
const checkedServer = () => vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/update/check')

it('asks the server when the desktop updater is unsupported, instead of spinning', async () => {
  const bridge = installBridge(async () => ({ phase: 'unsupported', reason: 'package' }))
  await mount()
  expect(checkedServer()).toBe(true)
  expect(bridge.check).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Up to date')
  expect(container.textContent).not.toContain('Checking…')
})

it('asks the server when the desktop bridge cannot report its state', async () => {
  installBridge(async () => { throw new Error('ipc gone') })
  await mount()
  expect(checkedServer()).toBe(true)
  expect(container.textContent).toContain('Up to date')
})

it('drives a supported desktop updater and leaves the server out of it', async () => {
  const bridge = installBridge(async () => ({ phase: 'current', checkedAt: '2026-11-13T00:00:00Z' }))
  await mount()
  expect(bridge.check).toHaveBeenCalled()
  expect(checkedServer()).toBe(false)
  expect(container.textContent).toContain('Up to date')
})
