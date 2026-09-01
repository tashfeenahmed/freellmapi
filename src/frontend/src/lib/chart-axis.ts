// recharts axis props for the category (provider / agent / error) bar charts on
// the analytics page.
//
// recharts' default `interval` is 'preserveEnd' (see `implicitXAxis` /
// `implicitYAxis` in recharts' axisSelectors): when the labels are wider than
// the space available it silently DROPS ticks, keeping the tail and thinning
// out everything before it. The visible result is the #890 complaint — only a
// few provider names render, the rest are only visible on hover, and the bars
// no longer line up with the labels the user can actually see (a bar with no
// label looks like a different provider than it is).
//
// The fix is to force EVERY tick (`interval={0}`) and then make the labels fit
// by rotating and truncating them. Forcing the ticks on its own just trades a
// dropped label for an unreadable pile of overlapping ones, so the rotation
// has to be chosen from how many categories there are — hence the tiers below.
// The timeline (timestamp) charts are time series and want none of this.

/** `fontSize` the analytics axes render their ticks at. */
export const AXIS_FONT_SIZE = 11

/**
 * Average advance width of one glyph at {@link AXIS_FONT_SIZE} in the UI font.
 * Deliberately an estimate: this module has to size the axis before layout, so
 * it cannot measure. ~0.5em is a good average for lowercase Latin in a
 * humanist sans, and provider/agent names are lowercase-heavy.
 */
const CHAR_WIDTH = 5.5

/** Line box of a single-line tick label — its thickness across the rotation. */
const LINE_HEIGHT = 13

/** Gap between the plot edge and the start of the label (tick line + margin). */
const TICK_GAP = 8

/**
 * Plot width of the narrowest panel we lay out for: the analytics grid is
 * `grid-cols-1` under `lg`, so on a phone a chart gets roughly this many
 * pixels. Every tier below is sized so its labels still clear each other here,
 * which means they clear each other on every wider screen too.
 */
const NARROW_PLOT_WIDTH = 280

/** Longest label shown in full on a shallow tier; longer ones are elided. */
export const MAX_AXIS_LABEL = 18

/**
 * Longest label on the steep (-90°) tier. A vertical label spends its whole
 * length on the axis height, so an 18-char cap there would eat ~110px of a
 * 240px chart. 12 keeps the reserved strip in line with the other tiers.
 */
export const MAX_AXIS_LABEL_STEEP = 12

const toRadians = (degrees: number) => (Math.abs(degrees) * Math.PI) / 180

/** Horizontal room one rotated label occupies, i.e. the minimum tick spacing. */
function bandWidth(angle: number): number {
  return LINE_HEIGHT / Math.sin(toRadians(angle))
}

/** Vertical room a `maxChars`-long label needs once rotated to `angle`. */
function axisHeight(angle: number, maxChars: number): number {
  return Math.ceil(maxChars * CHAR_WIDTH * Math.sin(toRadians(angle))) + TICK_GAP
}

/** How many categories fit at `angle` before the labels start to collide. */
function categoryCapacity(angle: number): number {
  return Math.floor(NARROW_PLOT_WIDTH / bandWidth(angle))
}

/**
 * Shallowest rotation first. A shallower angle is easier to read and costs
 * less vertical room; a steeper one packs more categories in. We take the
 * first tier that can seat the data, so charts with a handful of providers
 * keep the gentle -30° tilt and only crowded ones pay for -45°/-90°.
 */
const TIERS: ReadonlyArray<{ angle: number; maxChars: number }> = [
  { angle: -30, maxChars: MAX_AXIS_LABEL },
  { angle: -45, maxChars: MAX_AXIS_LABEL },
  { angle: -90, maxChars: MAX_AXIS_LABEL_STEEP },
]

export interface CategoryAxisProps {
  /** Show every category tick instead of letting recharts skip the middle ones. */
  interval: 0
  /** Tilt the labels so long provider names don't collide horizontally. */
  angle: number
  /** Anchor rotated labels to their tick. */
  textAnchor: 'end'
  /** Vertical room reserved for the (rotated) labels under the plot. */
  height: number
  /** Truncate over-long labels so the rotated ticks stay legible. */
  tickFormatter: (value: string) => string
}

/** Truncate `value` to `max` characters, spending the last one on an ellipsis. */
export function truncateAxisLabel(value: string, max: number = MAX_AXIS_LABEL): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

/**
 * The XAxis props that make a horizontal category chart show all of its labels.
 *
 * @param categoryCount how many bars the chart is about to draw. Callers know
 *   their own `data.length`; passing it lets the axis pick a rotation that
 *   still fits. Omitting it assumes the roomiest (shallowest) tier.
 */
export function categoryAxisProps(categoryCount = 0): CategoryAxisProps {
  const tier = TIERS.find((t) => categoryCount <= categoryCapacity(t.angle)) ?? TIERS[TIERS.length - 1]
  return {
    interval: 0,
    angle: tier.angle,
    textAnchor: 'end',
    height: axisHeight(tier.angle, tier.maxChars),
    tickFormatter: (value: string) => truncateAxisLabel(value, tier.maxChars),
  }
}

/** Width reserved for the category axis of a `layout="vertical"` bar chart. */
export const VERTICAL_AXIS_WIDTH = 128

/** Longest label that fits inside {@link VERTICAL_AXIS_WIDTH}. */
const VERTICAL_MAX_LABEL = Math.min(
  MAX_AXIS_LABEL,
  Math.floor((VERTICAL_AXIS_WIDTH - TICK_GAP) / CHAR_WIDTH),
)

export interface VerticalCategoryAxisProps {
  /** Show every category tick — 'preserveEnd' drops them here too. */
  interval: 0
  /** Horizontal room reserved for the labels beside the plot. */
  width: number
  /** Truncate over-long labels so they stay inside {@link VERTICAL_AXIS_WIDTH}. */
  tickFormatter: (value: string) => string
}

/**
 * The YAxis props for a `layout="vertical"` category chart (bars run left to
 * right, so the *category* axis is the Y one). Rotation doesn't help here:
 * labels sit side-on in their own gutter and are limited by that gutter's
 * width, not by the tick spacing. So this is just "show every tick, and keep
 * each label short enough to fit the gutter".
 */
export function verticalCategoryAxisProps(): VerticalCategoryAxisProps {
  return {
    interval: 0,
    width: VERTICAL_AXIS_WIDTH,
    tickFormatter: (value: string) => truncateAxisLabel(value, VERTICAL_MAX_LABEL),
  }
}
