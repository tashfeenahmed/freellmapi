// @vitest-environment jsdom
// A custom embedding endpoint can serve an ASYMMETRIC model (NVIDIA Nemotron
// 3.5), which refuses a request that carries no input_type. The operator
// names the side in the Custom provider form, and the form has to say which
// of the three states it means: not specified (leave the model alone),
// explicitly symmetric (send none), or a side (send it).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CustomProviderSection } from './custom-provider-section'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))
// A native <select> stands in for the Base UI listbox so the test can pick a
// type. The input-type listbox gets its own testid so the two do not collide.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="select" value={value} onChange={e => onValueChange(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}))

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  // The Keys page query backs the group-label suggestions, which iterate the
  // result, so /api/keys has to answer with an array.
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) =>
    (path === '/api/keys' ? [] : {}))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root.render(<QueryClientProvider client={client}><I18nProvider initialLocale="en"><CustomProviderSection /></I18nProvider></QueryClientProvider>))
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

// The custom-type listbox is the first <select>; the input-type one only
// exists while the type is "embedding".
function selectWithOption(option: string): HTMLSelectElement {
  return [...container.querySelectorAll<HTMLSelectElement>('select')]
    .find(s => s.querySelector(`option[value="${option}"]`))!
}

async function addEmbedding(inputType?: string) {
  setValue(selectWithOption('embedding'), 'embedding')
  setValue(container.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:11434/v1"]')!, 'http://127.0.0.1:9000/v1')
  setValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'nemotron-embed')
  if (inputType !== undefined) setValue(selectWithOption(inputType), inputType)
  await act(async () => { container.querySelector('form')!.requestSubmit() })
  const posts = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/embeddings/custom')
  expect(posts.length).toBeGreaterThan(0)
  const post = posts[posts.length - 1]
  return JSON.parse(String(post![1]!.body)) as Record<string, unknown>
}

describe('custom embedding input_type', () => {
  it('offers the input-type listbox only for embedding endpoints', () => {
    expect(selectWithOption('embedding')).toBeTruthy()
    expect(container.querySelectorAll('select')).toHaveLength(1)
    setValue(selectWithOption('embedding'), 'embedding')
    // Now there are two: the model kind and the input type.
    expect(container.querySelectorAll('select')).toHaveLength(2)
    setValue(selectWithOption('chat'), 'chat')
    expect(container.querySelectorAll('select')).toHaveLength(1)
  })

  it('sends no input_type when the operator does not specify one', async () => {
    // "Not specified" means "leave the model alone" — the field is absent, so
    // a stored choice survives a re-submit.
    const body = await addEmbedding()
    expect(body).not.toHaveProperty('inputType')
  })

  it('sends the named side', async () => {
    expect((await addEmbedding('query')).inputType).toBe('query')
    expect((await addEmbedding('passage')).inputType).toBe('passage')
  })

  it('sends null for an explicitly symmetric endpoint', async () => {
    // null (not absent): the operator declares the endpoint symmetric, which
    // clears a stored input_type.
    expect((await addEmbedding('none')).inputType).toBeNull()
  })

  it('validates positive integer rate limits and resets them after submit', async () => {
    setValue(selectWithOption('embedding'), 'embedding')
    setValue(container.querySelector<HTMLInputElement>('input[placeholder="http://127.0.0.1:11434/v1"]')!, 'http://127.0.0.1:9000/v1')
    setValue(container.querySelector<HTMLTextAreaElement>('textarea')!, 'nemotron-embed')
    const rpmInput = container.querySelector<HTMLInputElement>('input[placeholder="RPM"]')!

    // Invalid input (non-numeric or 0) blocks submit rather than sending NaN/null.
    setValue(rpmInput, 'abc')
    await act(async () => { container.querySelector('form')!.requestSubmit() })
    expect(vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/embeddings/custom')).toHaveLength(0)
    expect(rpmInput.getAttribute('aria-invalid')).toBe('true')

    // Valid positive integer submits and resets after success.
    setValue(rpmInput, '40')
    await act(async () => { container.querySelector('form')!.requestSubmit() })
    const posts = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/embeddings/custom')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]![1]!.body)).rpmLimit).toBe(40)
    expect(rpmInput.value).toBe('')
  })
})
