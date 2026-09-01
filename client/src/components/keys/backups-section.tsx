import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, getToken } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ConfirmButton } from '@/components/confirm-button'
import { Archive, ChevronDown, Download, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'

interface BackupMeta {
  id: number
  filename: string
  filesize: number
  isFull: boolean
  source: 'manual' | 'scheduled' | 'pre-restore'
  createdAt: string
  tables: string[]
}

interface BackupSchedule {
  enabled: boolean
  time: string
  intervalDays: number
  backupPath: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// The dump is a file download, not JSON, so it goes through fetch directly
// rather than apiFetch — with the same bearer token the rest of /api uses.
async function downloadBackupFile(id: number, filename: string): Promise<void> {
  const token = getToken()
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  const res = await fetch(`${base}/api/backups/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    toast.error(body?.error?.message ?? `HTTP ${res.status}`)
    return
  }
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Database dumps, as a collapsed section beside the outbound-proxy settings.
 *
 * Collapsed by default and mounted lazily: backups are a once-in-a-while
 * operation, and the Keys page belongs to the unified key. Expanding is what
 * loads the list, the table names and the schedule.
 */
export function BackupsSection() {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  return (
    <section className="rounded-3xl border bg-card p-5">
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div>
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Archive className="size-3.5 text-muted-foreground" />
            {t('backups.title')}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('backups.description')}</p>
        </div>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </button>

      {expanded && <BackupsPanel />}
    </section>
  )
}

function BackupsPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const pageSize = 10

  const { data: tables = [] } = useQuery<string[]>({
    queryKey: ['backup-tables'],
    queryFn: () => apiFetch<{ tables: string[] }>('/api/backups/tables').then(r => r.tables),
  })

  const { data: list } = useQuery<{ items: BackupMeta[]; total: number }>({
    queryKey: ['backups', page],
    queryFn: () => apiFetch(`/api/backups?page=${page}&pageSize=${pageSize}`),
  })

  const { data: schedule } = useQuery<{ schedule: BackupSchedule }>({
    queryKey: ['backup-schedule'],
    queryFn: () => apiFetch('/api/backups/schedule'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['backups'] })
    queryClient.invalidateQueries({ queryKey: ['backup-schedule'] })
  }

  const create = useMutation({
    meta: { silenceToast: true },
    mutationFn: (chosen: string[]) =>
      apiFetch<{ backup: BackupMeta }>('/api/backups', {
        method: 'POST',
        body: JSON.stringify(chosen.length > 0 ? { tables: chosen } : {}),
      }),
    onSuccess: result => {
      toast.success(t('backups.created', { filename: result.backup.filename }))
      setSelected(new Set())
      setPage(1)
      invalidate()
    },
    onError: error => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const restore = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: number) =>
      apiFetch<{ snapshot: BackupMeta }>(`/api/backups/${id}/restore`, { method: 'POST' }),
    onSuccess: result => {
      toast.success(t('backups.restored', { filename: result.snapshot.filename }))
      invalidate()
      // Restore replaces the routing tables wholesale; every cached list is stale.
      queryClient.invalidateQueries()
    },
    onError: error => toast.error(error instanceof Error ? error.message : String(error)),
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/backups/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const total = list?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="mt-5 space-y-6 border-t pt-5">
      {/* What a dump does and does not carry: the one thing an operator must
          know before mailing the file to themselves. */}
      <p className="rounded-2xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t('backups.excludedNote')}
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground flex-1 min-w-40">{t('backups.selectHint')}</p>
          <Button variant="ghost" size="xs" onClick={() => setSelected(new Set(tables))} disabled={tables.length === 0}>
            {t('backups.selectAll')}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            {t('backups.deselectAll')}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {tables.map(table => {
            const isOn = selected.has(table)
            return (
              <button
                key={table}
                type="button"
                aria-pressed={isOn}
                onClick={() => {
                  const next = new Set(selected)
                  if (isOn) next.delete(table)
                  else next.add(table)
                  setSelected(next)
                }}
                className={`inline-flex h-6 items-center rounded-4xl border px-2 font-mono text-[11px] transition-colors ${
                  isOn ? 'border-ring bg-muted' : 'border-border hover:bg-muted/50'
                }`}
              >
                {table}
              </button>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => create.mutate([])} disabled={create.isPending}>
            {t('backups.fullBackup')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => create.mutate([...selected])}
            disabled={create.isPending || selected.size === 0}
          >
            {t('backups.backupSelected', { count: selected.size })}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium">{t('backups.list')}</h3>
        {list && list.items.length > 0 ? (
          <>
            <ul className="divide-y rounded-2xl border">
              {list.items.map(item => (
                <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{item.filename}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()} · {formatBytes(item.filesize)} ·{' '}
                      {item.isFull ? t('backups.full') : t('backups.tablesCount', { count: item.tables.length })}
                    </div>
                  </div>
                  <Badge variant={item.source === 'manual' ? 'outline' : 'secondary'}>
                    {item.source === 'scheduled'
                      ? t('backups.scheduled')
                      : item.source === 'pre-restore'
                        ? t('backups.preRestore')
                        : t('backups.manual')}
                  </Badge>
                  <div className="inline-flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t('backups.download')}
                      aria-label={t('backups.download')}
                      onClick={() => void downloadBackupFile(item.id, item.filename)}
                    >
                      <Download />
                    </Button>
                    <ConfirmButton
                      size="xs"
                      onConfirm={() => restore.mutate(item.id)}
                      disabled={restore.isPending}
                      confirmLabel={t('backups.confirmRestore')}
                    >
                      {t('backups.restore')}
                    </ConfirmButton>
                    <ConfirmButton
                      size="icon-sm"
                      armedSize="xs"
                      onConfirm={() => remove.mutate(item.id)}
                      title={t('backups.delete')}
                      aria-label={t('backups.delete')}
                    >
                      <Trash2 />
                    </ConfirmButton>
                  </div>
                </li>
              ))}
            </ul>
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" size="xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  {t('backups.prevPage')}
                </Button>
                <span className="text-[11px] text-muted-foreground">{page} / {totalPages}</span>
                <Button variant="ghost" size="xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  {t('backups.nextPage')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="rounded-2xl border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            {t('backups.empty')}
          </p>
        )}
      </div>

      <AutoBackupForm schedule={schedule?.schedule ?? null} onSaved={invalidate} />
    </div>
  )
}

function AutoBackupForm({ schedule, onSaved }: { schedule: BackupSchedule | null; onSaved: () => void }) {
  const { t } = useI18n()
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('03:00')
  const [intervalDays, setIntervalDays] = useState('1')
  const [backupPath, setBackupPath] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    if (!schedule) return
    setEnabled(schedule.enabled)
    setTime(schedule.time)
    setIntervalDays(String(schedule.intervalDays))
    setBackupPath(schedule.backupPath ?? '')
  }, [schedule])

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/backups/schedule', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
      onSaved()
    },
    onError: error => toast.error(error instanceof Error ? error.message : String(error)),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xs font-medium">{t('backups.autoTitle')}</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">{t('backups.autoHint')}</p>
        </div>
        <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} aria-label={t('backups.autoTitle')} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('backups.time')}</Label>
          <Input type="time" value={time} onChange={e => setTime(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('backups.intervalDays')}</Label>
          <Input type="number" min={1} max={365} value={intervalDays} onChange={e => setIntervalDays(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('backups.path')}</Label>
          <Input
            value={backupPath}
            onChange={e => setBackupPath(e.target.value)}
            placeholder={t('backups.pathPlaceholder')}
            className="font-mono text-xs"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('backups.pathHint')}</p>

      <Button
        size="sm"
        disabled={save.isPending}
        onClick={() =>
          save.mutate({
            enabled,
            time: time || '03:00',
            intervalDays: Math.max(1, Number.parseInt(intervalDays, 10) || 1),
            backupPath: backupPath.trim(),
          })
        }
      >
        {savedFlash ? t('backups.saved') : t('backups.save')}
      </Button>
    </div>
  )
}
