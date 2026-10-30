import type { ReactNode } from 'react'

// Everything inside is decoration. It is hidden from assistive technology and
// marked so the command center (and its tests) can tell it apart from data.
// Decorative components must not receive telemetry.
export function Decorative({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden="true" data-decorative="true" className={className}>
      {children}
    </div>
  )
}
