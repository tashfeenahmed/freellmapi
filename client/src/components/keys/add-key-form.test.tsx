// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { Platform } from '../../../../shared/types'
import { AddKeyForm } from './add-key-form'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

// #1331: key-optional providers (Kilo, OVH, AI Horde) keep the key field
// editable; a blank submit enables the anonymous tier, a real key is sent.
let root: Root
let container: HTMLDivElement
const onSuccess = vi.fn()

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_path: string, init?: RequestInit) =>
    init?.method === 'POST' ? { id: 1 } : [])
  onSuccess.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function mount(component: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en">{component}</I18nProvider></QueryClientProvider>))
}
function keyInput() {
  return container.querySelector<HTMLInputElement>('input[type="password"]')!
}
function enter(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
function posted() {
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
  return call ? JSON.parse(String(call[1]!.body)) : undefined
}

describe.each<Platform>(['kilo', 'ovh', 'aihorde'])('adding a %s key (key optional)', platform => {
  it('keeps the key field enabled with an Optional placeholder and the Get API key link', () => {
    mount(<AddKeyForm onSuccess={onSuccess} initialPlatform={platform} />)
    expect(keyInput().disabled).toBe(false)
    expect(keyInput().placeholder).toBe('Optional')
    expect(container.querySelector('a[href^="http"]')).not.toBeNull()
  })

  it('enables the anonymous tier when the key is left blank', async () => {
    mount(<AddKeyForm onSuccess={onSuccess} initialPlatform={platform} />)
    await submit()
    expect(posted()).toEqual({ platform, key: '' })
    expect(onSuccess).toHaveBeenCalled()
  })

  it('sends a real key when one is pasted', async () => {
    mount(<AddKeyForm onSuccess={onSuccess} initialPlatform={platform} />)
    enter(keyInput(), '  my-real-key  ')
    await submit()
    expect(posted()).toEqual({ platform, key: 'my-real-key' })
  })
})

it('still requires a key for a provider that needs one', async () => {
  mount(<AddKeyForm onSuccess={onSuccess} initialPlatform="groq" />)
  await submit()
  expect(posted()).toBeUndefined()
})
