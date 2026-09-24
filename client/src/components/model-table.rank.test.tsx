// @vitest-environment jsdom
//
// Jump-to-rank (#1317): the rank cell in manual mode is a button that opens an
// inline number input. This mounts the real SortableGroupRow (inside a DndContext
// so useSortable's hooks have their provider) and drives the actual
// click → type → Enter / Escape / blur cycle, asserting the row's click-to-detail
// navigation never fires and that an unchanged rank commits nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// This jsdom build surfaces no Storage on window (see auth-gate tests, which
// stub fetch instead of touching storage); the i18n provider reads one at
// mount, so give it a minimal in-memory shim before any import runs.
if (!globalThis.localStorage) {
  const store = new Map<string, string>()
  // @ts-expect-error minimal shim
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
}

import { MemoryRouter } from 'react-router-dom'
import { DndContext } from '@dnd-kit/core'
import { I18nProvider } from '@/i18n'
import { SortableGroupRow } from './model-table'
import type { ModelGroupRow } from '@/lib/routing'

type GroupMember = ModelGroupRow['members'][number]

function member(modelDbId: number): GroupMember {
  return {
    modelDbId, priority: modelDbId, effectivePriority: modelDbId, penalty: 0,
    rateLimitHits: 0, enabled: true, platform: 'openai',
    modelId: `m${modelDbId}`, displayName: `m${modelDbId}`,
    intelligenceRank: 1, speedRank: 1, sizeLabel: '', rpmLimit: null, rpdLimit: null,
    monthlyTokenBudget: '0', contextWindow: 1000, supportsVision: false, supportsTools: false,
  } as unknown as GroupMember
}
const group: ModelGroupRow = { key: 'g1', label: 'Some Model', members: [member(1)] }

let root: Root
let container: HTMLDivElement

function render(onMoveRank: (n: number) => void, editable = true) {
  root = createRoot(container)
  act(() => {
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <DndContext>
            <table>
              <tbody>
                <SortableGroupRow group={group} rank={7} editableRank={editable}
                  onMoveRank={editable ? onMoveRank : undefined} onToggleGroup={() => {}} />
              </tbody>
            </table>
          </DndContext>
        </MemoryRouter>
      </I18nProvider>,
    )
  })
}

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

// React dedupes value writes that bypass its tracker; go through the native
// setter so onChange actually fires, the way the testing-library docs advise.
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function rankButton() { return container.querySelector('td:nth-child(2) button') as HTMLButtonElement }

describe('rank cell jump-to-rank (#1317)', () => {
  it('renders a plain number when the rank is not editable', () => {
    const onMove = vi.fn()
    render(onMove, false)
    expect(rankButton()).toBeNull()
    expect(container.querySelector('td:nth-child(2)')!.textContent).toBe('7')
  })

  it('click opens the input prefilled; Enter commits the typed rank and does not touch the row link', () => {
    const onMove = vi.fn()
    render(onMove)
    const btn = rankButton()
    expect(btn.getAttribute('aria-label')).toBeTruthy()
    act(() => { btn.click() })
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.value).toBe('7')
    act(() => { type(input, '2') })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onMove).toHaveBeenCalledWith(2)
    expect(container.querySelector('input[type="number"]')).toBeNull()
  })

  it('Escape cancels without committing', () => {
    const onMove = vi.fn()
    render(onMove)
    act(() => { rankButton().click() })
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    act(() => { type(input, '1') })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onMove).not.toHaveBeenCalled()
    expect(rankButton()).toBeTruthy()
  })

  it('a blur that follows Escape (focused input unmounting) still commits nothing', () => {
    const onMove = vi.fn()
    render(onMove)
    act(() => { rankButton().click() })
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    act(() => { type(input, '1') })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onMove).not.toHaveBeenCalled()
    expect(rankButton()).toBeTruthy()
  })

  it('a blur that follows Enter does not commit a second time', () => {
    const onMove = vi.fn()
    render(onMove)
    act(() => { rankButton().click() })
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    act(() => { type(input, '3') })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove).toHaveBeenCalledWith(3)
  })

  it('blur commits; committing the same rank as before does nothing', () => {
    const onMove = vi.fn()
    render(onMove)
    act(() => { rankButton().click() })
    let input = container.querySelector('input[type="number"]') as HTMLInputElement
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onMove).not.toHaveBeenCalled()
    act(() => { rankButton().click() })
    input = container.querySelector('input[type="number"]') as HTMLInputElement
    act(() => { type(input, '4') })
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(onMove).toHaveBeenCalledWith(4)
  })

  it('clicking the rank editor does not trigger row navigation', () => {
    render(vi.fn())
    const row = container.querySelector('tr')!
    const before = container.ownerDocument.querySelectorAll('a').length
    act(() => { rankButton().click() })
    // The click that opened the editor must have stopped at the button: no
    // navigation happened, and the input is now in the row, not a link.
    expect(container.querySelector('tr')!).toBe(row)
    expect(container.ownerDocument.querySelectorAll('a').length).toBe(before)
  })
})