// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { deepEqual, useDraft, type Draft } from './use-draft'

type Value = { order: number[] }

let root: Root
let container: HTMLDivElement
let draft: Draft<Value>

function Probe({ server, scope, onDraft }: { server: Value; scope: unknown; onDraft: (d: Draft<Value>) => void }) {
  onDraft(useDraft(server, scope))
  return null
}
const render = (server: Value, scope: unknown = 'a') =>
  act(() => root.render(<Probe server={server} scope={scope} onDraft={d => { draft = d }} />))

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { container = document.createElement('div'); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()) })

describe('useDraft', () => {
  const server = { order: [1, 2] }

  it('shows the server value until edited, then the draft', () => {
    render(server)
    expect(draft.value).toBe(server)
    expect(draft.dirty).toBe(false)
    act(() => draft.edit({ order: [2, 1] }))
    expect(draft.value).toEqual({ order: [2, 1] })
    expect(draft.dirty).toBe(true)
  })

  it('is clean again when the edit is undone', () => {
    render(server)
    act(() => draft.edit({ order: [2, 1] }))
    act(() => draft.edit({ order: [1, 2] }))
    expect(draft.dirty).toBe(false)
    expect(draft.value).toBe(server)
  })

  it('drops a draft when the scope changes, and does not bring it back', () => {
    render(server, 'a')
    act(() => draft.edit({ order: [2, 1] }))
    render(server, 'b')
    expect(draft.dirty).toBe(false)
    render(server, 'a')
    expect(draft.dirty).toBe(false)
  })

  it('settles only the draft that was saved', () => {
    render(server)
    const saved = { order: [2, 1] }
    act(() => draft.edit(saved))
    act(() => draft.edit({ order: [2, 1, 3] }))
    act(() => draft.settle(saved))
    expect(draft.dirty).toBe(true)

    act(() => draft.settle(draft.value))
    expect(draft.dirty).toBe(false)
  })
})

describe('deepEqual', () => {
  it('compares structure, not identity or key order', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual(null, {})).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
  })
})
