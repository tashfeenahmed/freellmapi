// @vitest-environment jsdom
// #1174: the composer's + menu carries "Attach files" and the web search
// switch; while web search is on the + turns blue with a dot rather than
// putting a chip in the input.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LiquidComposer, type LiquidComposerProps } from './liquid-composer'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has neither; the goo layer measures itself and checks reduced motion.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = '' })

function render(over: Partial<LiquidComposerProps> = {}) {
  const props: LiquidComposerProps = {
    inputRef: createRef<HTMLTextAreaElement>(),
    value: '', onChange: () => {}, onKeyDown: () => {}, onPaste: () => {},
    placeholder: 'Type a message', hasContent: false, loading: false, onSend: () => {}, onAttach: () => {},
    labels: { add: 'Add files and tools', attach: 'Attach files', send: 'Send', sending: 'Sending' },
    dictation: { model: 'auto', apiKey: null, onText: () => {} },
    ...over,
  }
  act(() => root.render(<LiquidComposer {...props} />))
}

const plus = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Add files and tools"]')!

async function openMenu() {
  await act(async () => { plus().click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

it('opens a + menu with Attach files and the web search switch', async () => {
  const onAttach = vi.fn()
  const onToggle = vi.fn()
  render({ onAttach, webSearch: { enabled: false, available: true, label: 'Search the web', unavailableHint: 'Add a key', onToggle } })
  expect(document.querySelector('[data-testid="web-search-indicator"]')).toBeNull()
  await openMenu()
  const search = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!
  expect(search.textContent).toContain('Search the web')
  await act(async () => { search.click() })
  expect(onToggle).toHaveBeenCalledWith(true)
  const attach = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.includes('Attach files'))!
  await act(async () => { attach.click() })
  expect(onAttach).toHaveBeenCalled()
})

it('marks the + instead of showing a chip while web search is on', () => {
  render({ webSearch: { enabled: true, available: true, label: 'Search the web', unavailableHint: 'Add a key', onToggle: () => {} } })
  expect(document.querySelector('[data-testid="web-search-indicator"]')).not.toBeNull()
  expect(plus().getAttribute('aria-label')).toBe('Add files and tools · Search the web')
  expect(container.textContent).not.toContain('Web search on')
})

it('disables the switch and explains why when there is no search key', async () => {
  render({ webSearch: { enabled: false, available: false, label: 'Search the web', unavailableHint: 'Add a search key on the Keys page', onToggle: () => {} } })
  await openMenu()
  const search = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!
  expect(search.getAttribute('aria-disabled') ?? search.getAttribute('data-disabled')).not.toBeNull()
  expect(document.body.textContent).toContain('Add a search key on the Keys page')
})
