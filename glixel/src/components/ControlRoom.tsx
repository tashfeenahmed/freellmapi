import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSendJson, ApiError, isAuthError } from '@/lib/session'
import { getCapabilities, type ProviderChoice } from '@/lib/capabilities'
import { formatLatency, type ProvidersTelemetry } from '@/lib/telemetry'
import { CommandCenter } from './CommandCenter'

// GLIXEL Control Room. Every control here calls an existing, session-gated
// FreeLLMAPI endpoint; settings that only the server's environment can change
// are shown read-only with where to change them. Provider keys go to the
// server once and are never read back: the key field is cleared as soon as it
// is submitted, and the masked key the server echoes is not displayed.

const PRESETS = ['balanced', 'smartest', 'fastest', 'reliable', 'priority'] as const
type Preset = typeof PRESETS[number]
const PRESET_HELP: Record<Preset, string> = {
  balanced: 'weighs reliability, speed and capability',
  smartest: 'prefers the most capable models',
  fastest: 'prefers the quickest models',
  reliable: 'prefers models that fail least',
  priority: 'follows the manual order set on the dashboard',
}

interface RoutingState {
  strategy: string
  scores: Array<{ platform: string; modelId: string; displayName: string; enabled: boolean; score: number }>
}
interface KeyProvider { platform: string; name: string; kind: 'chat' | 'search'; keyless: boolean; configured: boolean; keyCount: number }
interface RequestRow { id: number; platform: string; modelId: string; status: string; latencyMs: number | null; error: string | null; createdAt: string; attemptCount: number }

const noAuthRetry = (failures: number, err: unknown) => !isAuthError(err) && failures < 1
const errorText = (err: unknown) => err instanceof ApiError ? err.message : 'The request failed.'

function Section({ title, note, children, testId }: { title: string; note?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="glx-panel min-w-0" aria-label={title} data-testid={testId}>
      <h2 className="glx-label mb-3">{title}</h2>
      {children}
      {note && <p className="mt-3 text-[11px] text-glx-muted">{note}</p>}
    </section>
  )
}

function AiPath({ provider, onProvider }: { provider: ProviderChoice; onProvider: (p: ProviderChoice) => void }) {
  const caps = useQuery({ queryKey: ['glixel', 'capabilities'], queryFn: getCapabilities, retry: noAuthRetry })
  return (
    <Section title="AI path" note="Each reply comes from the path chosen here. GLIXEL never switches to another path, or to a paid one, on its own." testId="ai-path-section">
      {caps.isPending && <p className="text-sm text-glx-muted">Loading…</p>}
      {caps.isError && <p className="text-sm text-glx-warn">Could not read GET /api/glixel/capabilities.</p>}
      <fieldset className="space-y-2">
        <legend className="sr-only">AI path</legend>
        {caps.data?.providers.map(p => (
          <label key={p.id} className={`flex gap-3 rounded border border-glx-line p-3 ${p.available ? '' : 'opacity-70'}`}>
            <input
              type="radio" name="ai-path" value={p.id} className="mt-1"
              checked={provider === p.id} disabled={!p.available}
              onChange={() => onProvider(p.id)}
            />
            <span className="min-w-0">
              <span className="block text-sm">{p.label} <span className="text-glx-muted">· {p.billing}</span></span>
              <span className="block text-xs text-glx-muted">
                {p.available ? (p.id === caps.data.defaultProvider ? 'Default. Uses your FreeLLMAPI routing.' : 'Available.') : <>Unavailable. {p.reason}</>}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </Section>
  )
}

function Routing({ providers }: { providers: ProvidersTelemetry | undefined }) {
  const queryClient = useQueryClient()
  const caps = useQuery({ queryKey: ['glixel', 'capabilities'], queryFn: getCapabilities, retry: noAuthRetry })
  const routing = useQuery({ queryKey: ['glixel', 'routing'], queryFn: () => apiGet<RoutingState>('/api/fallback/routing'), retry: noAuthRetry })
  const [pick, setPick] = useState<Preset | ''>('')
  const [confirming, setConfirming] = useState(false)
  const change = useMutation({
    mutationFn: (strategy: Preset) => apiSendJson('PUT', '/api/fallback/routing', { strategy }),
    onSettled: () => { setConfirming(false); void queryClient.invalidateQueries({ queryKey: ['glixel', 'routing'] }) },
  })

  const current = routing.data?.strategy
  const usable = new Set((providers?.providers ?? []).filter(p => p.state === 'connected' && p.automaticRouting.eligible).map(p => p.platform))
  const ready = (routing.data?.scores ?? []).filter(s => s.enabled && usable.has(s.platform)).sort((a, b) => b.score - a.score)
  const policy = caps.data?.routing

  return (
    <Section title="Routing" testId="routing-section">
      <dl className="glx-stats">
        <div><dt>Free-only routing</dt><dd data-testid="cr-free-only">{policy ? (policy.freeOnly.enabled ? 'On' : 'Off') : '—'}</dd></div>
        <div><dt>Max fallback attempts</dt><dd data-testid="cr-max-attempts">{policy?.fallbackMaxAttempts ?? '—'}</dd></div>
      </dl>
      <p className="mt-2 text-[11px] text-glx-muted">
        Read-only here: set on the server with FREE_ONLY_ROUTING, FREE_ONLY_ALLOW_PLATFORMS and FALLBACK_MAX_ATTEMPTS, then restart it.
        {policy && policy.freeOnly.optedIn.length > 0 && ` Opted in: ${policy.freeOnly.optedIn.map(o => o.platform).join(', ')}.`}
      </p>

      <div className="mt-4 space-y-2">
        <p className="text-sm">Strategy: <span className="text-glx-cyan" data-testid="cr-strategy">{current ?? (routing.isError ? 'unavailable' : '…')}</span></p>
        {current && !(PRESETS as readonly string[]).includes(current) && (
          <p className="text-xs text-glx-muted">This strategy has extra settings; change it on the dashboard&apos;s <a className="glx-link" href="/models/chat">Models</a> page.</p>
        )}
        {current && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="cr-strategy-pick" className="sr-only">New routing strategy</label>
            <select id="cr-strategy-pick" className="glx-select w-full sm:w-auto min-w-0" value={pick} onChange={e => { setPick(e.target.value as Preset); setConfirming(false) }}>
              <option value="">Change strategy…</option>
              {PRESETS.filter(p => p !== current).map(p => <option key={p} value={p}>{p} — {PRESET_HELP[p]}</option>)}
            </select>
            {pick && !confirming && <button type="button" className="glx-button" onClick={() => setConfirming(true)}>Apply</button>}
          </div>
        )}
        {pick && confirming && (
          <div className="rounded border border-glx-warn/50 p-3 space-y-2" data-testid="confirm-strategy">
            <p className="text-sm">Switch routing from {current} to {pick}? This affects every app using this FreeLLMAPI server, not just GLIXEL. Free-only routing stays as it is.</p>
            <div className="flex gap-2">
              <button type="button" className="glx-button" disabled={change.isPending} onClick={() => change.mutate(pick)}>Switch to {pick}</button>
              <button type="button" className="glx-button" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>
        )}
        {change.isError && <p className="text-xs text-glx-warn" role="alert">Not changed: {errorText(change.error)}</p>}
        {change.isSuccess && !confirming && <p className="text-xs text-glx-ok" role="status">Routing strategy updated.</p>}
      </div>

      <div className="mt-4">
        <h3 className="text-xs text-glx-muted mb-1">Models ready for automatic routing (top by current score)</h3>
        {ready.length === 0
          ? <p className="text-sm text-glx-muted">{routing.isPending ? 'Loading…' : 'None yet: add a key for a free provider below.'}</p>
          : (
            <ol className="text-sm space-y-1" data-testid="cr-models">
              {ready.slice(0, 8).map(m => (
                <li key={`${m.platform}/${m.modelId}`} className="flex gap-2 min-w-0">
                  <span className="font-mono text-xs text-glx-muted w-10 shrink-0">{m.score.toFixed(2)}</span>
                  <span className="min-w-0 truncate">{m.displayName} <span className="text-glx-muted">· {m.platform}</span></span>
                </li>
              ))}
            </ol>
          )}
        {ready.length > 8 && <p className="mt-1 text-[11px] text-glx-muted">{ready.length - 8} more on the dashboard&apos;s <a className="glx-link" href="/models/chat">Models</a> page.</p>}
      </div>
    </Section>
  )
}

function AddKey() {
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['glixel', 'key-providers'], queryFn: () => apiGet<{ providers: KeyProvider[] }>('/api/keys/providers'), retry: noAuthRetry })
  const [platform, setPlatform] = useState('')
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [result, setResult] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const choices = (list.data?.providers ?? []).filter(p => p.kind === 'chat' && !p.keyless)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!platform || !key.trim() || busy) return
    const secret = key.trim()
    setKey('') // the key leaves component state before the request is even sent
    setBusy(true)
    setResult(null)
    const name = choices.find(c => c.platform === platform)?.name ?? platform
    try {
      const saved = await apiSendJson<{ id: number }>('POST', '/api/keys', { platform, key: secret, ...(label.trim() ? { label: label.trim() } : {}) })
      setLabel('')
      setResult({ tone: 'ok', text: `Saved for ${name}. Checking it with ${name}…` })
      try {
        const check = await apiSendJson<{ status: string }>('POST', `/api/health/check/${saved.id}`)
        setResult(check.status === 'healthy'
          ? { tone: 'ok', text: `Saved for ${name}. ${name} accepted the key.` }
          : { tone: 'warn', text: `Saved for ${name}, but the check reported "${check.status}". Review it on the dashboard's Keys page.` })
      } catch {
        setResult({ tone: 'warn', text: `Saved for ${name}. The check could not run; it will be checked automatically later.` })
      }
    } catch (err) {
      setResult({ tone: 'warn', text: `Not saved: ${errorText(err)}` })
    } finally {
      setBusy(false)
      void queryClient.invalidateQueries({ queryKey: ['glixel'] })
    }
  }

  return (
    <Section
      title="Add a provider key" testId="add-key-section"
      note="The key goes once to your FreeLLMAPI server, which stores it encrypted. GLIXEL never shows it again or keeps a copy. To disable, remove or reveal keys, use the dashboard's Keys page."
    >
      <form className="space-y-3" onSubmit={e => void submit(e)} autoComplete="off">
        <div>
          <label htmlFor="cr-platform" className="block text-xs text-glx-muted mb-1">Provider</label>
          <select id="cr-platform" className="glx-select w-full" value={platform} onChange={e => setPlatform(e.target.value)} disabled={busy}>
            <option value="">{list.isPending ? 'Loading…' : 'Choose a provider'}</option>
            {choices.map(c => <option key={c.platform} value={c.platform}>{c.name}{c.configured ? ` (${c.keyCount} key${c.keyCount > 1 ? 's' : ''})` : ''}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cr-key" className="block text-xs text-glx-muted mb-1">API key</label>
          <input
            id="cr-key" type="password" className="glx-input w-full" value={key} onChange={e => setKey(e.target.value)}
            autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="cr-label" className="block text-xs text-glx-muted mb-1">Label (optional)</label>
          <input id="cr-label" className="glx-input w-full" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} disabled={busy} />
        </div>
        <button type="submit" className="glx-button" disabled={!platform || !key.trim() || busy}>{busy ? 'Saving…' : 'Save key'}</button>
        {result && <p className={`text-xs ${result.tone === 'ok' ? 'text-glx-ok' : 'text-glx-warn'}`} role="status" data-testid="add-key-result">{result.text}</p>}
      </form>
    </Section>
  )
}

function RecentRequests() {
  const q = useQuery({
    queryKey: ['glixel', 'recent-requests'],
    queryFn: () => apiGet<{ total: number; rows: RequestRow[] }>('/api/analytics/requests?range=24h&limit=10'),
    retry: noAuthRetry,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
  return (
    <Section title="Recent requests (24 h)" note="From GET /api/analytics/requests. Full history is on the dashboard's Analytics page." testId="recent-requests">
      {q.isPending && <p className="text-sm text-glx-muted">Loading…</p>}
      {q.isError && <p className="text-sm text-glx-warn">Could not read request history.</p>}
      {q.data?.rows.length === 0 && <p className="text-sm text-glx-muted">No requests in the last 24 hours.</p>}
      <ul className="divide-y divide-glx-line">
        {q.data?.rows.map(r => (
          <li key={r.id} className="py-2 text-sm">
            <div className="flex flex-wrap gap-x-2 min-w-0">
              <span className={r.status === 'success' ? 'text-glx-ok' : r.status === 'error' ? 'text-glx-bad' : 'text-glx-muted'}>{r.status}</span>
              <span className="min-w-0 break-all">{r.platform}/{r.modelId}</span>
              <span className="ml-auto font-mono text-xs text-glx-muted">{formatLatency(r.latencyMs)}{r.attemptCount > 1 ? ` · ${r.attemptCount} tries` : ''}</span>
            </div>
            {r.error && <p className="text-[11px] text-glx-muted break-words line-clamp-2">{r.error}</p>}
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function ControlRoom({ provider, onProvider }: { provider: ProviderChoice; onProvider: (p: ProviderChoice) => void }) {
  const providers = useQuery({ queryKey: ['glixel', 'providers'], queryFn: () => apiGet<ProvidersTelemetry>('/api/providers'), retry: noAuthRetry })
  return (
    <div className="pb-6 space-y-4">
      <CommandCenter />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 items-start">
        <AiPath provider={provider} onProvider={onProvider} />
        <Routing providers={providers.data} />
        <AddKey />
        <RecentRequests />
      </div>
      <p className="text-[11px] text-glx-muted">
        Everything else (deleting keys, proxies, model lists, backups) stays on the <a className="glx-link" href="/">dashboard</a>.
      </p>
    </div>
  )
}
