// @vitest-environment jsdom
// M29: the composer mic's phases. A click while the browser's permission
// prompt is open must not open a second microphone; a recorder that fails to
// construct must release the mic; an unmounted button must not keep the mic
// or send a clip; and Stop must work while a reply is streaming.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { toast } from '@/lib/toast'
import { DictationButton, type DictationButtonProps } from './dictation-button'

vi.mock('@/lib/toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static throwOnCreate = false
  static isTypeSupported = () => false
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  readonly stream: MediaStream
  constructor(stream: MediaStream) {
    if (FakeRecorder.throwOnCreate) throw new Error('recorder refused')
    this.stream = stream
    FakeRecorder.instances.push(this)
  }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['clip']) })
    queueMicrotask(() => this.onstop?.())
  }
}

let root: Root
let container: HTMLDivElement
let track: { stop: ReturnType<typeof vi.fn> }
let grant: (stream: MediaStream) => void
const getUserMedia = vi.fn()
const fetchMock = vi.fn()

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  FakeRecorder.instances = []
  FakeRecorder.throwOnCreate = false
  track = { stop: vi.fn() }
  getUserMedia.mockReset().mockImplementation(() => new Promise<MediaStream>(resolve => { grant = resolve }))
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }))
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  vi.mocked(toast.error).mockReset()
})
afterEach(() => {
  act(() => root.unmount()); container.remove()
  vi.unstubAllGlobals()
})

const stream = () => ({ getTracks: () => [track] }) as unknown as MediaStream
const button = () => container.querySelector<HTMLButtonElement>('button')!
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
function mount(over: Partial<DictationButtonProps> = {}) {
  act(() => root.render(
    <I18nProvider initialLocale="en">
      <DictationButton available model="auto" apiKey="k" onText={() => {}} {...over} />
    </I18nProvider>,
  ))
}

it('ignores clicks while the permission prompt is open: one mic, one recorder', async () => {
  mount()
  act(() => button().click())
  expect(button().dataset.phase).toBe('requesting')
  act(() => button().click())
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  await act(async () => grant(stream()))
  expect(FakeRecorder.instances).toHaveLength(1)
  expect(button().dataset.phase).toBe('recording')
})

it('releases the mic and returns to idle when the recorder cannot be created', async () => {
  FakeRecorder.throwOnCreate = true
  mount()
  act(() => button().click())
  await act(async () => grant(stream()))
  expect(track.stop).toHaveBeenCalled()
  expect(button().dataset.phase).toBe('idle')
  expect(toast.error).toHaveBeenCalled()
})

it('closes a mic granted after the button unmounted, without recording', async () => {
  mount()
  act(() => button().click())
  act(() => root.unmount())
  await act(async () => grant(stream()))
  expect(track.stop).toHaveBeenCalled()
  expect(FakeRecorder.instances).toHaveLength(0)
  root = createRoot(container)
})

it('sends nothing when it unmounts while recording', async () => {
  const onText = vi.fn()
  mount({ onText })
  act(() => button().click())
  await act(async () => grant(stream()))
  act(() => root.unmount())
  await flush()
  expect(track.stop).toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(onText).not.toHaveBeenCalled()
  root = createRoot(container)
})

it('can still be stopped while the composer is busy with a reply', async () => {
  const onText = vi.fn()
  mount({ onText })
  act(() => button().click())
  await act(async () => grant(stream()))
  mount({ onText, disabled: true })
  expect(button().disabled).toBe(false)
  act(() => button().click())
  await flush()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(onText).toHaveBeenCalledWith('hello')
  expect(button().dataset.phase).toBe('idle')
})
