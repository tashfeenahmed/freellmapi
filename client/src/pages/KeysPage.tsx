import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform } from '../../../shared/types'

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'google', label: 'Google AI Studio' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'github-copilot', label: 'GitHub Copilot (device flow)' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)' },
  { value: 'ollama', label: 'Ollama Cloud' },
  { value: 'kilo', label: 'Kilo Gateway (anon ok)' },
  { value: 'pollinations', label: 'Pollinations (anon ok)' },
  { value: 'llm7', label: 'LLM7 (anon ok)' },
  { value: 'huggingface', label: 'HuggingFace Router' },
]

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

function formatTierLabel(tier: string | null | undefined): string {
  if (!tier) return 'unknown'
  if (tier === 'pro+') return 'Pro+'
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          Regenerate
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-md select-all truncate tabular-nums">
          {showKey ? apiKey : masked}
        </code>
        <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
          {showKey ? 'Hide' : 'Show'}
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">Endpoint</span>
        <code className="font-mono">/v1/chat/completions</code>
      </div>
    </section>
  )
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const needsAccountId = platform === 'cloudflare'
  const isCopilotFlow = platform === 'github-copilot'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const onCopilotDone = () => {
    queryClient.invalidateQueries({ queryKey: ['keys'] })
    queryClient.invalidateQueries({ queryKey: ['health'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
    setPlatform('')
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = PLATFORMS.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          keys.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
              {checkAll.isPending ? 'Checking…' : 'Check all'}
            </Button>
          )
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            {!isCopilotFlow && (
              <>
                <div className="space-y-1.5 flex-1 min-w-[240px]">
                  <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder={needsAccountId ? 'Bearer token' : 'paste key here'}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                    placeholder="optional"
                    className="w-[160px]"
                  />
                </div>
                <Button type="submit" size="sm" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
                  {addKey.isPending ? 'Adding…' : 'Add key'}
                </Button>
              </>
            )}
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
          {isCopilotFlow && (
            <CopilotDeviceFlow onDone={onCopilotDone} />
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">Configured providers</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="rounded-lg border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <CopilotKeyRow
                          key={k.id}
                          k={k}
                          status={status}
                          lastChecked={lastChecked}
                          onCheck={() => checkKey.mutate(k.id)}
                          onRemove={() => deleteKey.mutate(k.id)}
                          checking={checkKey.isPending}
                          removing={deleteKey.isPending}
                        />
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function CopilotKeyRow({
  k,
  status,
  lastChecked,
  onCheck,
  onRemove,
  checking,
  removing,
}: {
  k: ApiKey
  status: string
  lastChecked: string | null | undefined
  onCheck: () => void
  onRemove: () => void
  checking: boolean
  removing: boolean
}) {
  const queryClient = useQueryClient()
  const [editingTier, setEditingTier] = useState(false)
  const [pickedTier, setPickedTier] = useState<string>(k.tier ?? 'pro')
  const [saving, setSaving] = useState(false)

  const isCopilot = k.platform === 'github-copilot'

  const saveTier = async () => {
    setSaving(true)
    try {
      await apiFetch('/api/keys/copilot/set-tier', {
        method: 'POST',
        body: JSON.stringify({ keyId: k.id, tier: pickedTier }),
      })
      setEditingTier(false)
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    } catch {
      // Surface failure inline via the button's disabled state recovery;
      // a richer error toast can land later.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
      <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
      <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
      {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
      <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
      {isCopilot && !editingTier && (
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
          Plan: {formatTierLabel(k.tier)}
        </span>
      )}
      {isCopilot && editingTier && (
        <div className="flex items-center gap-1.5">
          <Select value={pickedTier} onValueChange={(v) => v && setPickedTier(v)}>
            <SelectTrigger className="w-[140px] h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COPILOT_TIER_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="xs" onClick={saveTier} disabled={saving}>
            {saving ? '…' : 'Save'}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setEditingTier(false)}>Cancel</Button>
        </div>
      )}
      <div className="flex-1" />
      {lastChecked && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      {isCopilot && !editingTier && (
        <Button variant="ghost" size="xs" onClick={() => setEditingTier(true)}>
          Change plan
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={onCheck} disabled={checking}>
        Check
      </Button>
      <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={onRemove} disabled={removing}>
        Remove
      </Button>
    </div>
  )
}

interface CopilotStartResp {
  sessionId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

interface CopilotPollResp {
  status: 'pending' | 'slow_down' | 'success' | 'error'
  id?: number
  masked?: string
  message?: string
  /** null when the Step-3 exchange failed (404/network/parse) — UI
   *  drops into the manual plan-picker flow in that case. */
  tier?: string | null
}

const COPILOT_TIER_OPTIONS = [
  { value: 'free',       label: 'Free' },
  { value: 'pro',        label: 'Pro' },
  { value: 'pro+',       label: 'Pro+' },
  { value: 'student',    label: 'Student' },
  { value: 'business',   label: 'Business' },
  { value: 'enterprise', label: 'Enterprise' },
] as const

function CopilotDeviceFlow({ onDone }: { onDone: () => void }) {
  // 'idle' = before Start, 'awaiting' = polling, 'pick-tier' = exchange
  // succeeded but auto-detection of plan failed and the user needs to
  // pick manually, 'success'/'error' terminal.
  const [phase, setPhase] = useState<'idle' | 'starting' | 'awaiting' | 'pick-tier' | 'success' | 'error'>('idle')
  const [session, setSession] = useState<CopilotStartResp | null>(null)
  const [message, setMessage] = useState<string>('')
  const [codeCopied, setCodeCopied] = useState(false)
  const [savedKeyId, setSavedKeyId] = useState<number | null>(null)
  const [savedMasked, setSavedMasked] = useState<string>('')
  const [pickedTier, setPickedTier] = useState<string>('pro')
  const [tierSaving, setTierSaving] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intervalMs = useRef(5000)

  const clearTimer = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }

  // Stop polling on unmount so we don't leak a tab-background timer.
  useEffect(() => () => clearTimer(), [])

  const start = async () => {
    setPhase('starting')
    setMessage('')
    try {
      const resp = await apiFetch<CopilotStartResp>('/api/keys/copilot/start', { method: 'POST', body: '{}' })
      setSession(resp)
      intervalMs.current = (resp.interval + 1) * 1000
      setPhase('awaiting')
      // Kick off the polling loop on the next tick.
      pollTimer.current = setTimeout(() => poll(resp.sessionId), intervalMs.current)
    } catch (err: any) {
      setPhase('error')
      setMessage(err?.message ?? 'Failed to start')
    }
  }

  const poll = async (sessionId: string) => {
    let resp: CopilotPollResp
    try {
      resp = await apiFetch<CopilotPollResp>('/api/keys/copilot/poll', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      })
    } catch (err: any) {
      setPhase('error')
      setMessage(err?.message ?? 'Poll failed')
      return
    }

    switch (resp.status) {
      case 'pending':
        pollTimer.current = setTimeout(() => poll(sessionId), intervalMs.current)
        return
      case 'slow_down':
        // RFC 8628: server is telling us to back off — bump interval.
        intervalMs.current += 5000
        pollTimer.current = setTimeout(() => poll(sessionId), intervalMs.current)
        return
      case 'success':
        setSavedKeyId(resp.id ?? null)
        setSavedMasked(resp.masked ?? '')
        if (resp.tier) {
          setPhase('success')
          setMessage(`Saved as ${resp.masked} (id ${resp.id}). Plan auto-detected: ${formatTierLabel(resp.tier)}.`)
          onDone()
        } else {
          // Step-3 exchange didn't return a usable sku. Fall back to a
          // manual pick — the user knows which plan they have.
          setPhase('pick-tier')
          setMessage(`Saved as ${resp.masked} (id ${resp.id}). Plan auto-detection failed — please pick:`)
        }
        return
      case 'error':
        setPhase('error')
        setMessage(resp.message ?? 'Authorization failed')
        return
    }
  }

  const saveTier = async () => {
    if (!savedKeyId) return
    setTierSaving(true)
    try {
      await apiFetch('/api/keys/copilot/set-tier', {
        method: 'POST',
        body: JSON.stringify({ keyId: savedKeyId, tier: pickedTier }),
      })
      setPhase('success')
      setMessage(`Saved as ${savedMasked} (id ${savedKeyId}). Plan: ${formatTierLabel(pickedTier)} (manual).`)
      onDone()
    } catch (err: any) {
      setPhase('error')
      setMessage(err?.message ?? 'Failed to save tier')
    } finally {
      setTierSaving(false)
    }
  }

  const copyCode = async () => {
    if (!session) return
    // navigator.clipboard.writeText requires a secure context; behavior is
    // inconsistent across http://<lan-ip> hosts that aren't localhost. Fall
    // back to a hidden-textarea + execCommand so the button still works
    // when serving the dashboard from a Tailscale IP or non-secure origin.
    let ok = false
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(session.userCode)
        ok = true
      } catch { /* fall through to legacy path */ }
    }
    if (!ok) {
      const el = document.createElement('textarea')
      el.value = session.userCode
      el.style.position = 'fixed'
      el.style.opacity = '0'
      el.style.pointerEvents = 'none'
      document.body.appendChild(el)
      el.focus()
      el.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      document.body.removeChild(el)
    }
    if (ok) {
      setCodeCopied(true)
      setTimeout(() => setCodeCopied(false), 1500)
    }
  }

  const reset = () => {
    clearTimer()
    setSession(null)
    setMessage('')
    setPhase('idle')
  }

  return (
    <div className="mt-3 rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground mb-3">
        GitHub Copilot uses the OAuth device flow. Click Start, open the URL we show, and paste the code.
        We never see your GitHub password — only the resulting access token, which is stored encrypted.
      </div>

      {phase === 'idle' && (
        <Button size="sm" onClick={start}>Start GitHub login</Button>
      )}

      {phase === 'starting' && (
        <p className="text-xs text-muted-foreground">Requesting a device code…</p>
      )}

      {phase === 'awaiting' && session && (
        <div className="space-y-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 items-center text-xs">
            <span className="text-muted-foreground">1. Open</span>
            <a
              href={session.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-2 hover:text-primary"
            >
              {session.verificationUri}
            </a>
            <span className="text-muted-foreground">2. Enter code</span>
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm tracking-wider bg-muted px-2.5 py-1 rounded-md select-all">
                {session.userCode}
              </code>
              <Button variant="outline" size="sm" onClick={copyCode}>
                {codeCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <span className="text-muted-foreground">3. Approve</span>
            <span className="text-muted-foreground">Waiting for GitHub… polling every {Math.round(intervalMs.current / 1000)}s.</span>
          </div>
          <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>
        </div>
      )}

      {phase === 'pick-tier' && (
        <div className="space-y-3">
          <p className="text-sm text-amber-700 dark:text-amber-300">{message}</p>
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Plan</Label>
              <Select value={pickedTier} onValueChange={(v) => v && setPickedTier(v)}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COPILOT_TIER_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" onClick={saveTier} disabled={tierSaving}>
              {tierSaving ? 'Saving…' : 'Save plan'}
            </Button>
            <Button variant="ghost" size="sm" onClick={reset}>Skip</Button>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <div className="space-y-2">
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Connected. {message}</p>
          <Button variant="ghost" size="sm" onClick={reset}>Add another</Button>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{message}</p>
          <Button variant="ghost" size="sm" onClick={reset}>Try again</Button>
        </div>
      )}
    </div>
  )
}
