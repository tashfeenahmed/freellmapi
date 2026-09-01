import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Hover tooltip rendered through a portal to document.body, so it's never
// clipped by an ancestor's overflow (e.g. a table's overflow-x-auto). Position
// is computed from the trigger's rect and clamped to the viewport. `side`
// picks which edge it opens from (use 'bottom' under sticky headers).
export function Tooltip({ text, children, side = 'top', className }: {
  text: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null)

  function show() {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const half = 116 // ~half of the w-56 tooltip
    const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8)
    setCoords({ x, y: side === 'top' ? r.top : r.bottom })
  }
  const hide = () => setCoords(null)

  // #826: a hover tooltip lingers after a dialog (copy full key / model
  // scope) is opened on top of its trigger and closed again — the mouse never
  // actually leaves the trigger, so `mouseleave` never fires and the tooltip
  // stays until the pointer happens to cross another hot-zone. Two
  // complementary cleanups, both only attached while a tooltip is showing:
  //  - hide on any mousemove that leaves the trigger's rect (with a small
  //    tolerance to avoid flicker at the edge) — the pointer-events-none
  //    tooltip itself never intercepts events, so this is the reliable
  //    cleanup when the pointer actually moves away;
  //  - hide on any pointerdown (covers the click that opens the dialog) and
  //    on Escape (the dialog's own close key), so a tooltip can't outlive the
  //    popup that covered it even if the pointer never moves.
  useEffect(() => {
    if (!coords) return
    const onMove = (e: MouseEvent) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const inside = e.clientX >= r.left - 4 && e.clientX <= r.right + 4
        && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
      if (!inside) hide()
    }
    const onPointerDown = () => hide()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [coords])

  return (
    <span
      ref={ref}
      className={className ?? 'inline-flex'}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {coords && createPortal(
        <span
          role="tooltip"
          style={{
            position: 'fixed',
            left: coords.x,
            top: side === 'top' ? coords.y - 8 : coords.y + 8,
            transform: side === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
            zIndex: 9999,
          }}
          className="pointer-events-none w-56 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-md whitespace-pre-line"
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}
