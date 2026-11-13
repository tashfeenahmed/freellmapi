// @vitest-environment jsdom
// Group rows (#580) show an axis across providers. The bar must read like the
// filled single-provider bars beside it: solid up to the weakest provider,
// faded up to the strongest, label "lo–hi".
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AxisRangeBar } from './model-table'

let root: Root
let container: HTMLDivElement
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const render = (values: (number | undefined)[]) => act(() => root.render(<AxisRangeBar values={values} color="#22c55e" />))
const part = (name: string) => container.querySelector<HTMLElement>(`[data-part="${name}"]`)

it('fills solid to the low value and faded to the high value, both from the left', () => {
  render([0.98, 0.63])
  expect(part('floor')!.style.width).toBe('63%')
  expect(part('spread')!.style.width).toBe('98%')
  for (const p of [part('floor')!, part('spread')!]) expect(p.className).toContain('left-0')
  expect(container.textContent).toContain('63–98')
})

it('a narrow spread still reads as a filled bar, not a sliver', () => {
  render([0.55, 0.59])
  expect(part('floor')!.style.width).toBe('55%')
  expect(part('spread')!.style.width).toBe('59%')
})

it('collapses to the plain bar when providers agree, and ignores unmeasured ones', () => {
  render([0.7, undefined, 0.7])
  expect(part('floor')).toBeNull()
  expect(container.textContent).toContain('70')
  expect(container.textContent).not.toContain('–70')
})
