// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { CopyKeyDialog } from './copy-key-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Keep the real form and state; remove only portal/focus management.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

let root: Root
let container: HTMLDivElement
const onOpenChange = vi.fn()
let resolveReveal: (value: { key: string }) => void
let revealSignal: AbortSignal | undefined

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  // A reveal that stays in flight until the test settles it.
  vi.mocked(apiFetch).mockReset().mockImplementation((_path, options) => {
    revealSignal = options?.signal ?? undefined
    return new Promise(resolve => { resolveReveal = resolve as typeof resolveReveal })
  })
  vi.mocked(copyText).mockReset().mockResolvedValue(true)
  vi.mocked(toast.success).mockReset()
  onOpenChange.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function mount() {
  act(() => root.render(
    <I18nProvider initialLocale="en">
      <CopyKeyDialog keyId={3} maskedKey="sk-***" onOpenChange={onOpenChange} />
    </I18nProvider>,
  ))
}
function enterPassword(value: string) {
  const input = container.querySelector<HTMLInputElement>('#reveal-password')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
function submit() {
  act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
function clickCancel() {
  const cancel = [...container.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!
  act(() => { cancel.click() })
}

describe('copying a full key', () => {
  it('copies the revealed key and closes', async () => {
    mount()
    enterPassword('pw')
    submit()
    await act(async () => { resolveReveal({ key: 'sk-live-secret' }) })
    await flush()
    expect(copyText).toHaveBeenCalledWith('sk-live-secret')
    expect(toast.success).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Cancel used to close the dialog while the reveal kept going: the key
  // still landed on the clipboard and a "copied" toast appeared afterwards.
  it('does not copy the key when Cancel is pressed while the reveal is in flight', async () => {
    mount()
    enterPassword('pw')
    submit()
    clickCancel()
    expect(revealSignal?.aborted).toBe(true)
    await act(async () => { resolveReveal({ key: 'sk-live-secret' }) })
    await flush()
    expect(copyText).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('does not copy the key when the dialog unmounts while the reveal is in flight', async () => {
    mount()
    enterPassword('pw')
    submit()
    act(() => root.render(<I18nProvider initialLocale="en">{null}</I18nProvider>))
    expect(revealSignal?.aborted).toBe(true)
    await act(async () => { resolveReveal({ key: 'sk-live-secret' }) })
    await flush()
    expect(copyText).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
