import type { ReactNode } from 'react'
import { formatClock, type Freshness } from '@/lib/telemetry'

const LABEL: Record<Freshness, string> = {
  loading: 'Loading',
  live: 'Live',
  stale: 'Stale',
  unavailable: 'Unavailable',
}

// Every number GLIXEL shows lives in one of these: it names the endpoint the
// figure came from and when it was observed, and says plainly when the data is
// missing or old.
export function TelemetryPanel({
  title, source, freshness, observedAt, observedLabel = 'observed', children,
}: {
  title: string
  source: string
  freshness: Freshness
  observedAt: Date | null
  observedLabel?: 'observed' | 'fetched'
  children: ReactNode
}) {
  return (
    <section className="glx-panel" data-telemetry={source} data-freshness={freshness} aria-label={title}>
      <header className="flex items-center justify-between gap-2 mb-3">
        <h2 className="glx-label">{title}</h2>
        <span className={`glx-chip glx-chip-${freshness}`}>{LABEL[freshness]}</span>
      </header>
      {freshness === 'loading' && <p className="text-sm text-glx-muted">Reading telemetry…</p>}
      {freshness === 'unavailable' && <p className="text-sm text-glx-warn">No data: {source} could not be read.</p>}
      {(freshness === 'live' || freshness === 'stale') && children}
      <footer className="mt-3 text-[11px] text-glx-muted font-mono break-all">
        {source} · {observedLabel} {formatClock(observedAt)}
        {freshness === 'stale' && ' · last refresh failed or is old'}
      </footer>
    </section>
  )
}
