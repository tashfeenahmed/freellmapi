import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet, getSessionToken, isAuthError } from '@/lib/session'
import {
  configuredProviders, formatClock, formatLatency, formatPercent, freshness, parseServerTime, summarizeFleet,
  type HealthTelemetry, type ProvidersTelemetry,
} from '@/lib/telemetry'
import { IntelligenceCore } from './IntelligenceCore'
import { TelemetryPanel } from './TelemetryPanel'
import { SignInRequired } from './SignInRequired'

// Read-only command center. All figures come from existing session-gated
// endpoints (GET /api/providers, GET /api/health); nothing is written and no
// new server endpoint is involved. Refreshes every 60 s while the tab is
// visible, never in the background.
const REFRESH_MS = 60_000

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

const STATE_DOT: Record<string, string> = {
  connected: 'bg-glx-ok',
  unhealthy: 'bg-glx-bad',
  disabled: 'bg-glx-muted',
}

export function CommandCenter() {
  const hasToken = getSessionToken() !== null
  const now = useNow(15_000)
  const query = {
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    // One retry for a transient failure; never retry a rejected session.
    retry: (failures: number, err: unknown) => !isAuthError(err) && failures < 1,
    enabled: hasToken,
  }
  const providers = useQuery({ queryKey: ['glixel', 'providers'], queryFn: () => apiGet<ProvidersTelemetry>('/api/providers'), ...query })
  const health = useQuery({ queryKey: ['glixel', 'health'], queryFn: () => apiGet<HealthTelemetry>('/api/health'), ...query })

  if (!hasToken || isAuthError(providers.error) || isAuthError(health.error)) return <SignInRequired />

  const providersFresh = freshness({
    hasData: providers.data !== undefined, fetchedAt: providers.dataUpdatedAt || undefined,
    failed: providers.isError, loading: providers.isPending, now,
  })
  const healthFresh = freshness({
    hasData: health.data !== undefined, fetchedAt: health.dataUpdatedAt || undefined,
    failed: health.isError, loading: health.isPending, now,
  })
  const observed = parseServerTime(providers.data?.generatedAt)
  const fleet = providers.data ? summarizeFleet(providers.data.providers) : null
  const rows = providers.data ? configuredProviders(providers.data.providers) : []
  const degradation = health.data?.degradation

  return (
    <div className="pb-6">
        <section className="grid gap-4 md:grid-cols-[minmax(0,320px)_1fr] items-start">
          <div className="glx-panel">
            <IntelligenceCore />
            <p className="mt-3 text-center text-sm text-glx-muted">Agents, automations at its finest.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TelemetryPanel title="Routing" source="GET /api/providers" freshness={providersFresh} observedAt={observed}>
              {providers.data && fleet && (
                <dl className="glx-stats">
                  <div><dt>Free-only routing</dt><dd data-testid="free-only">{providers.data.freeOnly.enabled ? 'On' : 'Off'}</dd></div>
                  <div><dt>Models ready for automatic routing</dt><dd data-testid="auto-models">{fleet.automaticallyRoutableModels}</dd></div>
                  {providers.data.freeOnly.optedIn.filter(o => o.warning).map(o => (
                    <div key={o.platform} className="col-span-2 text-glx-warn text-xs">{o.platform} opted in: {o.warning}</div>
                  ))}
                </dl>
              )}
            </TelemetryPanel>

            <TelemetryPanel title="Providers" source="GET /api/providers" freshness={providersFresh} observedAt={observed}>
              {fleet && (
                <dl className="glx-stats">
                  <div><dt>Connected</dt><dd data-testid="connected">{fleet.connected}</dd></div>
                  <div><dt>Unhealthy</dt><dd>{fleet.unhealthy}</dd></div>
                  <div><dt>Disabled</dt><dd>{fleet.disabled}</dd></div>
                  <div><dt>Not set up</dt><dd>{fleet.unconfigured}</dd></div>
                </dl>
              )}
            </TelemetryPanel>

            <TelemetryPanel title="Last 24 hours" source="GET /api/providers" freshness={providersFresh} observedAt={observed}>
              {fleet && (
                <dl className="glx-stats">
                  <div><dt>Requests</dt><dd data-testid="requests">{fleet.requests24h}</dd></div>
                  <div><dt>Succeeded</dt><dd data-testid="success">{formatPercent(fleet.successRate24h)}</dd></div>
                  <div><dt>Avg latency</dt><dd data-testid="latency">{formatLatency(fleet.avgLatencyMs24h)}</dd></div>
                  <div><dt>Active cooldowns</dt><dd>{fleet.activeCooldowns}</dd></div>
                </dl>
              )}
            </TelemetryPanel>

            <TelemetryPanel
              title="Gateway health" source="GET /api/health" freshness={healthFresh}
              observedAt={health.dataUpdatedAt ? new Date(health.dataUpdatedAt) : null} observedLabel="fetched"
            >
              {degradation && (
                <dl className="glx-stats">
                  <div><dt>Mode</dt><dd data-testid="mode">{degradation.state}</dd></div>
                  <div><dt>Providers with a usable key</dt><dd>{degradation.healthyProviders} of {degradation.totalProviders}</dd></div>
                </dl>
              )}
            </TelemetryPanel>
          </div>
        </section>

        <div className="mt-4">
          <TelemetryPanel title="Model health" source="GET /api/providers" freshness={providersFresh} observedAt={observed}>
            {rows.length === 0 ? (
              <p className="text-sm text-glx-muted">No provider keys configured yet. Add one on the dashboard's Keys page.</p>
            ) : (
              <ul className="divide-y divide-glx-line" data-testid="provider-rows">
                {rows.map(p => (
                  <li key={p.platform} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className={`size-2 shrink-0 ${STATE_DOT[p.state] ?? 'bg-glx-muted'}`} aria-hidden="true" />
                    <span className="mr-auto min-w-0 break-words">{p.name} <span className="text-glx-muted">· {p.state}</span></span>
                    <span className="font-mono text-xs text-glx-muted">
                      {p.traffic24h.requests > 0
                        ? `${p.traffic24h.requests} req · ${formatPercent(p.traffic24h.successRate)} · ${formatLatency(p.traffic24h.avgLatencyMs)}`
                        : 'no traffic 24h'}
                      {p.cooldowns.active > 0 && ` · ${p.cooldowns.active} cooling`}
                    </span>
                    <span className="basis-full text-[11px] text-glx-muted">
                      {p.automaticRouting.eligible ? 'used automatically' : `not used automatically: ${p.automaticRouting.reason ?? 'not eligible'}`}
                      {' · checked '}{formatClock(parseServerTime(p.lastCheckedAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TelemetryPanel>
        </div>

        <footer className="mt-6 text-[11px] text-glx-muted space-y-1" data-testid="legend">
          <p><span className="glx-chip glx-chip-live">Live</span> read from your FreeLLMAPI server; each panel names its endpoint and time.</p>
          <p><span className="glx-visual-only static">visual only</span> decoration, not data. The animated core shows nothing about system state.</p>
        </footer>
    </div>
  )
}
