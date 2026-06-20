import type { ReactNode } from 'react'

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span title={text}>
      {children}
    </span>
  )
}
