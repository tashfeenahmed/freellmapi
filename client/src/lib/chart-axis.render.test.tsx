// @vitest-environment jsdom
//
// The prop-shape tests next door prove `categoryAxisProps()` returns the right
// numbers. They cannot prove those numbers change what recharts draws — the
// original #890 fix would have passed them even if the props had been spread
// onto the wrong element. So this file mounts a real recharts <BarChart> and
// counts the <text> ticks that come out, both with and without our props.
//
// Two things make that work under jsdom:
//
//  1. recharts needs a laid-out size, and jsdom lays nothing out. We pass
//     explicit width/height to the chart instead of using ResponsiveContainer.
//  2. recharts decides which ticks to drop by *measuring* each label: it puts
//     the text in a hidden span and reads getBoundingClientRect(). jsdom
//     returns zeroes there, so every label would look infinitely thin and
//     nothing would ever be dropped — the "before" case would silently pass.
//     We stub the rect with a simple monospace-ish metric so the drop logic
//     has real widths to work with.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { categoryAxisProps, verticalCategoryAxisProps } from './chart-axis'

/** Stand-in glyph width, in px, for the measurement stub below. */
const MEASURED_CHAR_WIDTH = 6

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    const text = this.textContent ?? ''
    const fontSize = Number.parseFloat((this as HTMLElement).style?.fontSize ?? '') || 11
    const width = text.length * MEASURED_CHAR_WIDTH
    const height = fontSize * 1.2
    return {
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
})

afterAll(() => {
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect
})

const CHART_WIDTH = 400
const CHART_HEIGHT = 240
const tickStyle = { fontSize: 11 } as const

// 16 providers, each name long enough that recharts has to make a choice, and
// each still distinguishable after the steep tier truncates it to 12 chars.
const CATEGORY_COUNT = 16
const platforms = Array.from({ length: CATEGORY_COUNT }, (_, i) => ({
  platform: `p${String(i).padStart(2, '0')}-provider-name`,
  requests: i + 1,
}))
const errorCategories = Array.from({ length: CATEGORY_COUNT }, (_, i) => ({
  category: `e${String(i).padStart(2, '0')}-error-kind`,
  count: i + 1,
}))

function renderTicks(node: ReactElement, axisSelector: string): string[] {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  const ticks = [...host.querySelectorAll(`${axisSelector} .recharts-cartesian-axis-tick-value`)]
    .map((el) => el.textContent ?? '')
  act(() => {
    root.unmount()
  })
  host.remove()
  return ticks
}

describe('category XAxis rendering (#890)', () => {
  it('drops most provider labels with recharts defaults', () => {
    const ticks = renderTicks(
      <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={platforms}>
        <XAxis dataKey="platform" tick={tickStyle} />
        <Bar dataKey="requests" />
      </BarChart>,
      '.recharts-xAxis-tick-labels',
    )
    // This is the bug: 'preserveEnd' thins the axis right out. (The guard on
    // the low end keeps this from passing vacuously if the chart ever stops
    // rendering at all under jsdom.)
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThan(CATEGORY_COUNT)
    expect(ticks).not.toContain(platforms[0].platform)
  })

  it('renders every provider label with categoryAxisProps()', () => {
    const props = categoryAxisProps(CATEGORY_COUNT)
    const ticks = renderTicks(
      <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={platforms}>
        <XAxis dataKey="platform" tick={tickStyle} {...props} />
        <Bar dataKey="requests" />
      </BarChart>,
      '.recharts-xAxis-tick-labels',
    )
    expect(ticks).toHaveLength(CATEGORY_COUNT)
    // Every category is present, and each is still telling them apart.
    expect(ticks).toEqual(platforms.map((p) => props.tickFormatter(p.platform)))
    expect(new Set(ticks).size).toBe(CATEGORY_COUNT)
  })

  it('still renders every label when the categories are few', () => {
    const few = platforms.slice(0, 6)
    const props = categoryAxisProps(few.length)
    const ticks = renderTicks(
      <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={few}>
        <XAxis dataKey="platform" tick={tickStyle} {...props} />
        <Bar dataKey="requests" />
      </BarChart>,
      '.recharts-xAxis-tick-labels',
    )
    expect(ticks).toHaveLength(few.length)
  })
})

describe('category YAxis rendering, layout="vertical" (#890)', () => {
  it('drops error-category labels with recharts defaults', () => {
    const ticks = renderTicks(
      <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={errorCategories} layout="vertical">
        <XAxis type="number" tick={tickStyle} />
        <YAxis type="category" dataKey="category" tick={tickStyle} width={128} />
        <Bar dataKey="count" />
      </BarChart>,
      '.recharts-yAxis-tick-labels',
    )
    expect(ticks.length).toBeGreaterThan(0)
    expect(ticks.length).toBeLessThan(CATEGORY_COUNT)
    expect(ticks).not.toContain(errorCategories[0].category)
  })

  it('renders every error-category label with verticalCategoryAxisProps()', () => {
    const props = verticalCategoryAxisProps()
    const ticks = renderTicks(
      <BarChart width={CHART_WIDTH} height={CHART_HEIGHT} data={errorCategories} layout="vertical">
        <XAxis type="number" tick={tickStyle} />
        <YAxis type="category" dataKey="category" tick={tickStyle} {...props} />
        <Bar dataKey="count" />
      </BarChart>,
      '.recharts-yAxis-tick-labels',
    )
    expect(ticks).toHaveLength(CATEGORY_COUNT)
    expect(ticks).toEqual(errorCategories.map((e) => props.tickFormatter(e.category)))
  })
})
