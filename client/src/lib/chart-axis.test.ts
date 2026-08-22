import { describe, expect, it } from 'vitest'
import type { CategoryAxisProps } from './chart-axis'
import {
  categoryAxisProps,
  truncateAxisLabel,
  verticalCategoryAxisProps,
  MAX_AXIS_LABEL,
  MAX_AXIS_LABEL_STEEP,
  VERTICAL_AXIS_WIDTH,
} from './chart-axis'

// Same estimate the module sizes itself with: ~0.5em per glyph at 11px.
const CHAR_WIDTH = 5.5
const LINE_HEIGHT = 13
const NARROW_PLOT_WIDTH = 280

const sin = (deg: number) => Math.sin((Math.abs(deg) * Math.PI) / 180)

describe('categoryAxisProps (#890)', () => {
  it('forces every tick so recharts never skips a provider label', () => {
    // recharts' default interval is 'preserveEnd', which is exactly what hid
    // the middle provider names; 0 means "render a tick for every category".
    for (const count of [0, 1, 5, 10, 11, 15, 16, 40]) {
      expect(categoryAxisProps(count).interval).toBe(0)
    }
  })

  it('rotates labels and reserves vertical room for them', () => {
    const p = categoryAxisProps(5)
    expect(p.angle).not.toBe(0)
    expect(p.textAnchor).toBe('end')
    expect(p.height).toBeGreaterThan(30)
  })

  it('tilts harder as the chart gets more crowded', () => {
    // A handful of providers reads best on a gentle tilt...
    expect(categoryAxisProps(4).angle).toBe(-30)
    expect(categoryAxisProps(10).angle).toBe(-30)
    // ...but past what -30° can seat on a phone the labels have to steepen.
    expect(categoryAxisProps(11).angle).toBe(-45)
    expect(categoryAxisProps(15).angle).toBe(-45)
    expect(categoryAxisProps(16).angle).toBe(-90)
    // Beyond even the vertical tier's capacity we stay vertical — there is
    // nothing steeper, and interval 0 still beats dropping labels.
    expect(categoryAxisProps(500).angle).toBe(-90)
  })

  it('never lets a tilt pack labels closer together than they are thick', () => {
    // The point of the tiers: at the chosen angle, each label's horizontal
    // footprint must still fit the slice of a narrow (mobile) plot it gets.
    for (const count of [1, 5, 10, 11, 15, 16, 21]) {
      const { angle } = categoryAxisProps(count)
      const bandNeeded = LINE_HEIGHT / sin(angle)
      const bandAvailable = NARROW_PLOT_WIDTH / Math.max(count, 1)
      expect(bandAvailable).toBeGreaterThanOrEqual(bandNeeded)
    }
  })

  it('reserves enough height for the longest label it will actually draw', () => {
    // The original fix under-provisioned this: an 18-char label at -30° needs
    // ~50px and only ~48 were left after the tick gap.
    const longest = 'x'.repeat(64)
    for (const count of [1, 8, 10, 11, 15, 16, 40]) {
      const p = categoryAxisProps(count)
      const drawn = p.tickFormatter(longest)
      const needed = drawn.length * CHAR_WIDTH * sin(p.angle)
      expect(p.height).toBeGreaterThanOrEqual(needed)
    }
  })

  it('keeps the reserved strip a sane share of a 240px chart', () => {
    for (const count of [1, 12, 16, 40]) {
      expect(categoryAxisProps(count).height).toBeLessThanOrEqual(80)
    }
  })

  it('truncates to the cap that matches the tier it picked', () => {
    const long = 'anthropic-compatible-very-long-relay-host'
    expect(categoryAxisProps(4).tickFormatter(long).length).toBe(MAX_AXIS_LABEL)
    expect(categoryAxisProps(40).tickFormatter(long).length).toBe(MAX_AXIS_LABEL_STEEP)
  })

  it('assumes the roomiest tier when the caller does not pass a count', () => {
    // Compare the plain fields: the two tickFormatters are equivalent
    // closures, but not the same object, so toEqual would trip over them.
    const bare = ({ interval, angle, textAnchor, height }: CategoryAxisProps) =>
      ({ interval, angle, textAnchor, height })
    expect(bare(categoryAxisProps())).toEqual(bare(categoryAxisProps(1)))
    expect(categoryAxisProps().tickFormatter('x'.repeat(64)).length).toBe(MAX_AXIS_LABEL)
  })
})

describe('truncateAxisLabel', () => {
  it('truncates over-long labels but leaves short ones alone', () => {
    expect(truncateAxisLabel('groq')).toBe('groq')
    expect(truncateAxisLabel('x'.repeat(MAX_AXIS_LABEL))).toBe('x'.repeat(MAX_AXIS_LABEL))
    const long = truncateAxisLabel('anthropic-compatible-very-long-relay-host')
    expect(long.length).toBe(MAX_AXIS_LABEL)
    expect(long.endsWith('…')).toBe(true)
  })

  it('honours an explicit cap', () => {
    expect(truncateAxisLabel('anthropic-relay', 8)).toBe('anthrop…')
  })

  it('truncation is stable (idempotent) so a second pass changes nothing', () => {
    const once = truncateAxisLabel('anthropic-compatible-very-long-relay-host')
    expect(truncateAxisLabel(once)).toBe(once)
  })
})

describe('verticalCategoryAxisProps (#890, errors-by-category)', () => {
  it('forces every tick on the category (Y) axis of a vertical bar chart', () => {
    // implicitYAxis defaults to 'preserveEnd' just like the X one, so the
    // horizontal "errors by category" chart dropped labels the same way.
    expect(verticalCategoryAxisProps().interval).toBe(0)
  })

  it('keeps the gutter it reserves and truncates labels to fit it', () => {
    const p = verticalCategoryAxisProps()
    expect(p.width).toBe(VERTICAL_AXIS_WIDTH)
    const drawn = p.tickFormatter('upstream-authentication-failed')
    expect(drawn.length * CHAR_WIDTH).toBeLessThanOrEqual(VERTICAL_AXIS_WIDTH)
    expect(drawn.endsWith('…')).toBe(true)
    expect(p.tickFormatter('rate_limit')).toBe('rate_limit')
  })

  it('does not rotate — a side-on axis has its own gutter, not a tick pitch', () => {
    expect(verticalCategoryAxisProps()).not.toHaveProperty('angle')
  })
})
