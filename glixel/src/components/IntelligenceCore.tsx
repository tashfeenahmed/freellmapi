import { usePageVisible, usePrefersReducedMotion } from '@/hooks/motion'
import { Decorative } from './Decorative'

// The animated GLIXEL core. It is decoration only: it takes no props, reads no
// telemetry, and its motion means nothing about system state. Motion stops for
// reduced-motion users and while the page is hidden.

const RING = 12 // cells per side of the pixel lattice
const cells: Array<{ x: number; y: number; ring: number }> = []
for (let y = 0; y < RING; y++) {
  for (let x = 0; x < RING; x++) {
    const dx = x - (RING - 1) / 2
    const dy = y - (RING - 1) / 2
    const r = Math.sqrt(dx * dx + dy * dy)
    if (r < 1.6) cells.push({ x, y, ring: 0 })
    else if (r > 3 && r < 3.9) cells.push({ x, y, ring: 1 })
    else if (r > 5 && r < 5.9 && (x + y) % 2 === 0) cells.push({ x, y, ring: 2 })
  }
}

export function IntelligenceCore() {
  const reduced = usePrefersReducedMotion()
  const visible = usePageVisible()
  const animating = !reduced && visible
  return (
    <Decorative className="relative mx-auto w-full max-w-[280px] aspect-square">
      <svg
        viewBox={`0 0 ${RING} ${RING}`}
        className="glx-core w-full h-full"
        data-animating={animating ? 'true' : 'false'}
        style={{ animationPlayState: animating ? 'running' : 'paused' }}
        shapeRendering="crispEdges"
      >
        {cells.map(c => (
          <rect
            key={`${c.x}-${c.y}`}
            x={c.x + 0.1}
            y={c.y + 0.1}
            width={0.8}
            height={0.8}
            className={`glx-cell glx-ring-${c.ring}`}
            style={{
              animationDelay: `${((c.x * 7 + c.y * 3) % 12) * 0.15}s`,
              animationPlayState: animating ? 'running' : 'paused',
            }}
          />
        ))}
      </svg>
      <span className="glx-visual-only">visual only</span>
    </Decorative>
  )
}
