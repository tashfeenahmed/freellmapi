// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import en from '@/i18n/locales/en.json'
import { toast } from '@/lib/toast'
import type { TranscriptionModelRow } from '@/lib/transcription'
import PlaygroundPage from './PlaygroundPage'

const provider: TranscriptionModelRow = {
  id: 1, platform: 'groq', modelId: 'whisper', displayName: 'Whisper',
  modality: 'transcription', enabled: true, keyCount: 1,
}
const getUserMedia = vi.fn()
let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
})

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  client.setQueryData(['unified-key'], { apiKey: 'gateway-key' })
  vi.spyOn(toast, 'info').mockReturnValue(0)
  vi.stubGlobal('fetch', vi.fn())
  getUserMedia.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openPlayground(platform: string | undefined, models?: TranscriptionModelRow[]) {
  if (platform) {
    vi.stubGlobal('__FREEAPI_DESKTOP__', true)
    vi.stubGlobal('__FREEAPI_PLATFORM__', platform)
  }
  if (models) client.setQueryData(['media'], { models })
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><PlaygroundPage /></I18nProvider>
    </QueryClientProvider>,
  ))
  const mic = container.querySelector<HTMLButtonElement>('button[aria-label="Dictate"]')!
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="liquid-composer"] textarea')!
  mic.focus()
  return { mic, input }
}

it.each([
  ['darwin', en.playground.dictationMacShortcut],
  ['win32', en.playground.dictationWindowsShortcut],
])('focuses the composer and shows the OS shortcut without recording on %s', async (platform, hint) => {
  const { mic, input } = await openPlayground(platform, [{ ...provider, keyCount: 0 }, { ...provider, modality: 'audio' }])
  await act(async () => mic.click())
  expect(document.activeElement).toBe(input)
  expect(toast.info).toHaveBeenCalledWith(hint)
  expect(container.textContent).toContain(hint)
  expect(getUserMedia).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { name: 'browser', platform: undefined, models: [] },
  { name: 'Linux desktop', platform: 'linux', models: [] },
  { name: 'catalog pending', platform: 'win32', models: undefined },
  { name: 'keyed but disabled model', platform: 'darwin', models: [{ ...provider, enabled: false }] },
])('keeps the existing setup hint for $name', async ({ platform, models }) => {
  const { mic } = await openPlayground(platform, models)
  await act(async () => mic.click())
  expect(toast.info).toHaveBeenCalledWith(en.playground.dictationUnavailable)
  expect(document.activeElement).toBe(mic)
})

it('records and transcribes through the gateway when a desktop user has a provider key', async () => {
  getUserMedia.mockResolvedValue({ getTracks: () => [] })
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported() { return true }
    ondataavailable!: (event: { data: Blob }) => void
    onstop!: () => void
    start() {}
    stop() {
      this.ondataavailable({ data: new Blob(['test audio']) })
      this.onstop()
    }
  })
  vi.mocked(fetch).mockResolvedValue(Response.json({ text: 'Dictated message' }))
  const { mic, input } = await openPlayground('darwin', [provider])
  await act(async () => mic.click())
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
  expect(mic.dataset.phase).toBe('recording')
  await act(async () => mic.click())
  expect(fetch).toHaveBeenCalledWith('/v1/audio/transcriptions', expect.objectContaining({
    method: 'POST', headers: { Authorization: 'Bearer gateway-key' }, body: expect.any(FormData),
  }))
  expect(input.value).toBe('Dictated message')
  expect(toast.info).not.toHaveBeenCalled()
})
