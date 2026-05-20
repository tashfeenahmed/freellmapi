import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/page-header'
import { Download, Upload } from 'lucide-react'
import type { ApiKey, ApiKeyImportInput, ApiKeyImportResult, FreeLLMBackup, Platform } from '../../../shared/types'

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'google', label: 'Google AI Studio' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)' },
  { value: 'ollama', label: 'Ollama Cloud' },
  { value: 'kilo', label: 'Kilo Gateway (anon ok)' },
  { value: 'pollinations', label: 'Pollinations (anon ok)' },
  { value: 'llm7', label: 'LLM7 (anon ok)' },
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

type ImportMode = 'append' | 'replace'

interface BackupImportResult {
  success: boolean
  keys: ApiKeyImportResult
  fallback: { updated: number; skipped: number; errors: { index: number; message: string }[] }
  unifiedApiKey: { restored: boolean; skipped: boolean; reason?: string }
}

const platformValues = new Set<string>(PLATFORMS.map(p => p.value))

function isPlatform(value: string): value is Platform {
  return platformValues.has(value)
}

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === ',' && !quoted) {
      values.push(current.trim())
      current = ''
      continue
    }
    current += char
  }

  values.push(current.trim())
  return values
}

function parseEnabled(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'enabled', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'disabled', 'off'].includes(normalized)) return false
  return undefined
}

function normalizeImportKey(raw: unknown): ApiKeyImportInput | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const platform = String(entry.platform ?? '').trim()
  const key = String(entry.key ?? entry.apiKey ?? entry.api_key ?? '').trim()
  if (!isPlatform(platform) || !key) return null

  const label = String(entry.label ?? entry.name ?? '').trim()
  const enabled = parseEnabled(entry.enabled)
  return {
    platform,
    key,
    ...(label ? { label } : {}),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

function parseTextImport(text: string): ApiKeyImportInput[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  if (lines.length === 0) return []

  const firstRow = parseCsvLine(lines[0]).map(value => value.toLowerCase())
  const keyHeader = firstRow.findIndex(value => ['key', 'apikey', 'api_key'].includes(value))
  const platformHeader = firstRow.indexOf('platform')
  const hasHeader = platformHeader >= 0 && keyHeader >= 0

  if (hasHeader) {
    const labelHeader = firstRow.indexOf('label')
    const enabledHeader = firstRow.indexOf('enabled')
    return lines.slice(1).flatMap(line => {
      const row = parseCsvLine(line)
      const parsed = normalizeImportKey({
        platform: row[platformHeader],
        key: row[keyHeader],
        label: labelHeader >= 0 ? row[labelHeader] : undefined,
        enabled: enabledHeader >= 0 ? parseEnabled(row[enabledHeader]) : undefined,
      })
      return parsed ? [parsed] : []
    })
  }

  return lines.flatMap(line => {
    const eq = line.indexOf('=')
    if (eq > 0) {
      const platform = line.slice(0, eq).trim()
      const key = line.slice(eq + 1).trim()
      const parsed = normalizeImportKey({ platform, key })
      if (parsed) return [parsed]
    }

    const [platform, key, label, enabled] = parseCsvLine(line)
    const parsed = normalizeImportKey({ platform, key, label, enabled: parseEnabled(enabled) })
    return parsed ? [parsed] : []
  })
}

function buildImportRequest(text: string, mode: ImportMode): {
  endpoint: '/api/keys/import' | '/api/backup/import'
  body: unknown
} {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('No import data')

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return { endpoint: '/api/keys/import', body: { mode, keys: parsed } }
    }
    if (parsed && typeof parsed === 'object') {
      const backup = parsed as Record<string, unknown>
      if (Array.isArray(backup.providerKeys) || Array.isArray(backup.fallback) || typeof backup.unifiedApiKey === 'string') {
        return { endpoint: '/api/backup/import', body: { ...backup, mode } }
      }
      if (Array.isArray(backup.keys)) {
        return { endpoint: '/api/keys/import', body: { mode, keys: backup.keys } }
      }
    }
  } catch {
    // Fall back to CSV/plain text parsing.
  }

  const keys = parseTextImport(trimmed)
  if (keys.length === 0) throw new Error('No valid keys found')
  return { endpoint: '/api/keys/import', body: { mode, keys } }
}

function keyImportSummary(result: ApiKeyImportResult): string {
  const parts = [`${result.inserted} imported`]
  if (result.skipped) parts.push(`${result.skipped} skipped`)
  if (result.replaced) parts.push(`${result.replaced} replaced`)
  if (result.errors.length) parts.push(`${result.errors.length} errors`)
  return parts.join(', ')
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

  const { data } = useQuery<{ apiKey: string; pinned?: boolean }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const pinned = data?.pinned === true
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
          disabled={pinned || regenerate.isPending}
          title={pinned ? 'Pinned by FREEAPI_UNIFIED_API_KEY' : 'Regenerate unified API key'}
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
        {pinned ? (
          <>
            <span className="text-muted-foreground">Key mode</span>
            <code className="font-mono">pinned by env</code>
          </>
        ) : null}
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
  const [bulkText, setBulkText] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('append')
  const [importMessage, setImportMessage] = useState('')

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

  const downloadBackup = useMutation({
    mutationFn: () => apiFetch<FreeLLMBackup>('/api/backup/export'),
    onSuccess: backup => {
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `freellmapi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      link.click()
      URL.revokeObjectURL(url)
    },
  })

  const bulkImport = useMutation({
    mutationFn: ({ endpoint, body }: { endpoint: '/api/keys/import' | '/api/backup/import'; body: unknown }) =>
      apiFetch<ApiKeyImportResult | BackupImportResult>(endpoint, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      const keyResult = 'success' in result ? result.keys : result
      const fallbackUpdated = 'success' in result && result.fallback.updated > 0
        ? `, ${result.fallback.updated} fallback rules updated`
        : ''
      setImportMessage(`${keyImportSummary(keyResult)}${fallbackUpdated}`)
    },
    onError: error => setImportMessage((error as Error).message),
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const handleBulkImport = (e: React.FormEvent) => {
    e.preventDefault()
    try {
      setImportMessage('')
      bulkImport.mutate(buildImportRequest(bulkText, importMode))
    } catch (error) {
      setImportMessage((error as Error).message)
    }
  }

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setBulkText(await file.text())
      setImportMessage('')
    } catch (error) {
      setImportMessage((error as Error).message)
    } finally {
      event.target.value = ''
    }
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
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-medium">Backup and bulk import</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadBackup.mutate()}
              disabled={downloadBackup.isPending}
            >
              <Download className="size-4" />
              {downloadBackup.isPending ? 'Preparing' : 'Download backup'}
            </Button>
          </div>

          <form onSubmit={handleBulkImport} className="rounded-lg border p-4 bg-card space-y-3">
            <Textarea
              value={bulkText}
              onChange={event => setBulkText(event.target.value)}
              placeholder={'platform,key,label\ngoogle,AIza...,personal\ngroq,gsk...,batch'}
              className="min-h-[132px] font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Mode</Label>
                <Select value={importMode} onValueChange={value => setImportMode(value as ImportMode)}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">Append</SelectItem>
                    <SelectItem value="replace">Replace keys</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">File</Label>
                <Input
                  type="file"
                  accept=".json,.csv,.txt,application/json,text/csv,text/plain"
                  onChange={handleImportFile}
                  className="w-[260px]"
                />
              </div>
              <div className="flex-1" />
              {importMessage && <span className="text-xs text-muted-foreground">{importMessage}</span>}
              <Button type="submit" size="sm" disabled={!bulkText.trim() || bulkImport.isPending}>
                <Upload className="size-4" />
                {bulkImport.isPending ? 'Importing' : 'Import'}
              </Button>
            </div>
          </form>
        </section>

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
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
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
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            Check
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            Remove
                          </Button>
                        </div>
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
