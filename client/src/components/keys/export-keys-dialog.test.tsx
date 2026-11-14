// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { ExportKeysDialog } from './export-keys-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), getToken: () => null }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Keep the real form and state; the dialog shell becomes a div with a button
// that closes it the way Esc / the backdrop / the X do.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, onOpenChange }: { children: ReactNode; onOpenChange: (open: boolean) => void }) => (
    <div>
      <button type="button" data-testid="dismiss" onClick={() => onOpenChange(false)} />
      {children}
    </div>
  ),
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: () => null,
}))

const realFetch = globalThis.fetch
let root: Root
let container: HTMLDivElement
const onOpenChange = vi.fn()
const anchorClick = vi.fn()

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue([{ id: 1, platform: 'groq', status: 'healthy', exportable: true }])
  vi.mocked(toast.success).mockReset()
  onOpenChange.mockReset()
  anchorClick.mockReset()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClick)
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><ExportKeysDialog open onOpenChange={onOpenChange} /></I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label))!
const passwordInput = () => container.querySelector<HTMLInputElement>('#export-password')
function enterPassword(value: string) {
  const input = passwordInput()!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function submit() {
  act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('exporting keys behind re-auth', () => {
  it('Cancel on the password step drops the typed password and the last error', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Wrong password' } }), { status: 401 })) as unknown as typeof fetch
    await mount()
    act(() => button('Download').click())
    enterPassword('wrong')
    submit()
    await flush()
    expect(container.textContent).toContain('Wrong password')

    enterPassword('half-typed')
    act(() => button('Cancel').click())
    act(() => button('Download').click())

    expect(passwordInput()!.value).toBe('')
    expect(container.textContent).not.toContain('Wrong password')
  })

  // Closing used to leave the export running: the file still downloaded, with
  // a success toast, after the dialog was gone.
  it('closing while the export is in flight aborts it and downloads nothing', async () => {
    let release: (res: Response) => void = () => {}
    let signal: AbortSignal | undefined
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(resolve => { release = resolve })
    }) as unknown as typeof fetch
    await mount()
    act(() => button('Download').click())
    enterPassword('pw')
    submit()

    act(() => (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click())
    expect(signal?.aborted).toBe(true)
    await act(async () => { release(new Response('{}', { status: 200 })) })
    await flush()

    expect(anchorClick).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('downloads and closes when the password is accepted', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await mount()
    act(() => button('Download').click())
    enterPassword('pw')
    submit()
    await flush()
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
