import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Pencil, Trash2, X } from 'lucide-react'
import type { ApiKey, Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { AddCustomModelDialog } from './AddCustomModelDialog'
import { AliasSection } from './AliasSection'

// Drawer that surfaces every model row for one platform — regardless of source
// (migration / catalog / user) — and routes the maintainer's actions through
// the right /api/models endpoint:
//   - source='user'   → [Edit] + [Delete]   (DELETE hard-deletes the row)
//   - source!='user'  → [Edit] only         (Switch flips enabled via PATCH)
// The "Add" form drops a brand new row in as source='user' (POST).
//
// Two modes (#custom-platform-model-management):
//   kind='platform'       — built-in provider (groq, cerebras, …); single list
//   kind='customEndpoint' — one base_url with N keys; list grouped by key_id

interface ModelRow {
  id: number
  platform: Platform
  modelId: string
  displayName: string
  contextWindow: number | null
  enabled: boolean
  supportsVision: boolean
  supportsTools: boolean
  source: 'migration' | 'catalog' | 'user'
  keyId?: number | null
  aliasId?: number | null
  aliasPriority?: number
}

export type ManageModelsDrawerProps =
  | { open: true; onClose: () => void; kind: 'platform'; platform: Platform; platformLabel: string }
  | { open: true; onClose: () => void; kind: 'customEndpoint'; baseUrl: string; keys: ApiKey[] }
  | { open: false; onClose: () => void }

export function ManageModelsDrawer(props: ManageModelsDrawerProps) {
  if (!props.open) return null
  if (props.kind === 'customEndpoint') {
    return <CustomEndpointDrawer {...props} />
  }
  return <PlatformDrawer {...props} />
}

// -----------------------------------------------------------------------------
// Platform mode (existing behavior — unchanged)
// -----------------------------------------------------------------------------

interface PlatformDrawerProps {
  onClose: () => void
  platform: Platform
  platformLabel: string
}

function PlatformDrawer({ onClose, platform, platformLabel }: PlatformDrawerProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: allModels = [] } = useQuery<ModelRow[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })
  const rows = allModels.filter(m => m.platform === platform)

  const [showAdd, setShowAdd] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newContextWindow, setNewContextWindow] = useState('')
  const [newSupportsVision, setNewSupportsVision] = useState(false)
  const [newSupportsTools, setNewSupportsTools] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<{ displayName: string; contextWindow: string; supportsVision: boolean; supportsTools: boolean }>({
    displayName: '',
    contextWindow: '',
    supportsVision: false,
    supportsTools: false,
  })
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['models'] })

  const addModel = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch('/api/models', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidate()
      setShowAdd(false)
      setNewModelId('')
      setNewDisplayName('')
      setNewContextWindow('')
      setNewSupportsVision(false)
      setNewSupportsTools(false)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to add model'),
  })

  const updateModel = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to update model'),
  })

  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to delete model'),
  })

  function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newModelId.trim()) return
    const payload: Record<string, unknown> = {
      platform,
      modelId: newModelId.trim(),
    }
    if (newDisplayName.trim()) payload.displayName = newDisplayName.trim()
    const ctx = Number(newContextWindow)
    if (newContextWindow && Number.isFinite(ctx)) payload.contextWindow = ctx
    if (newSupportsVision) payload.supportsVision = true
    if (newSupportsTools) payload.supportsTools = true
    addModel.mutate(payload)
  }

  function startEdit(row: ModelRow) {
    setEditingId(row.id)
    setEditDraft({
      displayName: row.displayName,
      contextWindow: row.contextWindow == null ? '' : String(row.contextWindow),
      supportsVision: row.supportsVision,
      supportsTools: row.supportsTools,
    })
  }

  function submitEdit(id: number) {
    const patch: Record<string, unknown> = {
      displayName: editDraft.displayName,
      supportsVision: editDraft.supportsVision,
      supportsTools: editDraft.supportsTools,
    }
    if (editDraft.contextWindow === '') {
      patch.contextWindow = null
    } else {
      const ctx = Number(editDraft.contextWindow)
      if (Number.isFinite(ctx)) patch.contextWindow = ctx
    }
    updateModel.mutate({ id, patch })
  }

  return (
    <DrawerShell onClose={onClose} title={`${t('models.manage')} · ${platformLabel}`} subtitle={`${rows.length} models`} error={error}>
      <div className="rounded-2xl border bg-card p-4">
        {!showAdd ? (
          <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
            + {t('models.add')}
          </Button>
        ) : (
          <form onSubmit={submitAdd} className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">modelId</Label>
              <Input
                value={newModelId}
                onChange={e => setNewModelId(e.target.value)}
                placeholder="qwen-3-coder-next-512b"
                className="font-mono text-xs"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">displayName</Label>
              <Input
                value={newDisplayName}
                onChange={e => setNewDisplayName(e.target.value)}
                placeholder={newModelId || t('models.add')}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">contextWindow</Label>
              <Input
                value={newContextWindow}
                onChange={e => setNewContextWindow(e.target.value)}
                placeholder="131072"
                type="number"
                className="text-xs"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={newSupportsVision} onCheckedChange={setNewSupportsVision} />
                {t('models.vision')}
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={newSupportsTools} onCheckedChange={setNewSupportsTools} />
                {t('models.tools')}
              </label>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={addModel.isPending || !newModelId.trim()}>
                {addModel.isPending ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowAdd(false)
                  setError(null)
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="rounded-2xl border bg-card divide-y overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">{t('common.noData')}</div>
        ) : (
          rows.map(row => (
            <ModelListRow
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              editDraft={editDraft}
              setEditDraft={setEditDraft}
              startEdit={startEdit}
              cancelEdit={() => setEditingId(null)}
              submitEdit={submitEdit}
              updateModel={updateModel}
              deleteModel={deleteModel}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
            />
          ))
        )}
      </div>

      <AliasSection />
    </DrawerShell>
  )
}

// -----------------------------------------------------------------------------
// Custom-endpoint mode — list grouped by key_id; per-section "Add" entry plus a
// global one in the drawer header. Both open AddCustomModelDialog with different
// defaultSelectedKeyIds (all vs. just-this-one). #custom-platform-model-management
// -----------------------------------------------------------------------------

interface CustomEndpointDrawerProps {
  onClose: () => void
  baseUrl: string
  keys: ApiKey[]
}

function CustomEndpointDrawer({ onClose, baseUrl, keys }: CustomEndpointDrawerProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: allModels = [] } = useQuery<ModelRow[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })

  const keyIds = new Set(keys.map(k => k.id))
  const rows = allModels.filter(m => m.platform === 'custom' && m.keyId != null && keyIds.has(m.keyId))

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<{ displayName: string; contextWindow: string; supportsVision: boolean; supportsTools: boolean }>({
    displayName: '',
    contextWindow: '',
    supportsVision: false,
    supportsTools: false,
  })
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null when closed; { keyIds: number[] } sets the dialog's defaultSelectedKeyIds.
  const [dialogDefaults, setDialogDefaults] = useState<number[] | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['keys'] })
  }

  const updateModel = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to update model'),
  })

  const deleteModel = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to delete model'),
  })

  function startEdit(row: ModelRow) {
    setEditingId(row.id)
    setEditDraft({
      displayName: row.displayName,
      contextWindow: row.contextWindow == null ? '' : String(row.contextWindow),
      supportsVision: row.supportsVision,
      supportsTools: row.supportsTools,
    })
  }

  function submitEdit(id: number) {
    const patch: Record<string, unknown> = {
      displayName: editDraft.displayName,
      supportsVision: editDraft.supportsVision,
      supportsTools: editDraft.supportsTools,
    }
    if (editDraft.contextWindow === '') {
      patch.contextWindow = null
    } else {
      const ctx = Number(editDraft.contextWindow)
      if (Number.isFinite(ctx)) patch.contextWindow = ctx
    }
    updateModel.mutate({ id, patch })
  }

  // The scoped model_id is `${keyId}-${rawId}`; show the raw id in the row so
  // duplicates across keys read as "same modelId on two keys" not as gibberish.
  const stripScope = (modelId: string, keyId: number | null | undefined) => {
    if (keyId == null) return modelId
    const prefix = `${keyId}-`
    return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
  }

  return (
    <DrawerShell
      onClose={onClose}
      title={`${t('models.manage')} · Custom`}
      subtitle={baseUrl}
      error={error}
    >
      {/* Global add: all keys pre-selected */}
      <div className="rounded-2xl border bg-card p-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogDefaults(keys.map(k => k.id))}
        >
          + {t('models.add')}
        </Button>
      </div>

      {/* Per-key sections */}
      {keys.map(k => {
        const keyRows = rows.filter(r => r.keyId === k.id)
        return (
          <div key={k.id} className="rounded-2xl border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-medium truncate">
                  {k.label || `Key #${k.id}`}
                </span>
                <code className="text-[11px] font-mono text-muted-foreground flex-shrink-0">
                  {k.maskedKey}
                </code>
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDialogDefaults([k.id])}
              >
                + {t('models.add')}
              </Button>
            </div>
            <div className="divide-y">
              {keyRows.length === 0 ? (
                <div className="px-4 py-3 text-xs text-muted-foreground">{t('common.noData')}</div>
              ) : (
                keyRows.map(row => (
                  <ModelListRow
                    key={row.id}
                    row={{ ...row, modelId: stripScope(row.modelId, row.keyId) }}
                    isEditing={editingId === row.id}
                    editDraft={editDraft}
                    setEditDraft={setEditDraft}
                    startEdit={() => startEdit(row)}
                    cancelEdit={() => setEditingId(null)}
                    submitEdit={submitEdit}
                    updateModel={updateModel}
                    deleteModel={deleteModel}
                    confirmDeleteId={confirmDeleteId}
                    setConfirmDeleteId={setConfirmDeleteId}
                  />
                ))
              )}
            </div>
          </div>
        )
      })}

      <AliasSection />

      {dialogDefaults !== null && (
        <AddCustomModelDialog
          open={true}
          onClose={() => setDialogDefaults(null)}
          baseUrl={baseUrl}
          keys={keys}
          defaultSelectedKeyIds={dialogDefaults}
          onSubmitted={() => {
            invalidate()
            setDialogDefaults(null)
          }}
        />
      )}
    </DrawerShell>
  )
}

// -----------------------------------------------------------------------------
// Reusable bits
// -----------------------------------------------------------------------------

function DrawerShell({
  onClose,
  title,
  subtitle,
  error,
  children,
}: {
  onClose: () => void
  title: string
  subtitle?: string
  error: string | null
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex">
      <button
        type="button"
        className="flex-1 bg-black/40"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="w-full max-w-xl h-full bg-background border-l shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="min-w-0">
            <h2 className="text-sm font-medium truncate">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground truncate">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">
            <X className="size-4" />
          </Button>
        </div>

        {error && (
          <div className="mx-5 my-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {children}
        </div>
      </div>
    </div>
  )
}

function ModelListRow({
  row,
  isEditing,
  editDraft,
  setEditDraft,
  startEdit,
  cancelEdit,
  submitEdit,
  updateModel,
  deleteModel,
  confirmDeleteId,
  setConfirmDeleteId,
}: {
  row: ModelRow
  isEditing: boolean
  editDraft: { displayName: string; contextWindow: string; supportsVision: boolean; supportsTools: boolean }
  setEditDraft: (d: { displayName: string; contextWindow: string; supportsVision: boolean; supportsTools: boolean }) => void
  startEdit: (row: ModelRow) => void
  cancelEdit: () => void
  submitEdit: (id: number) => void
  updateModel: { mutate: (args: { id: number; patch: Record<string, unknown> }) => void; isPending: boolean }
  deleteModel: { mutate: (id: number) => void; isPending: boolean }
  confirmDeleteId: number | null
  setConfirmDeleteId: (v: number | null | ((c: number | null) => number | null)) => void
}) {
  const { t } = useI18n()
  const { data: aliases = [] } = useQuery<{ id: number; name: string; enabled: boolean }[]>({
    queryKey: ['aliases'],
    queryFn: () => apiFetch('/api/aliases'),
  })
  const enabledAliases = aliases.filter(a => a.enabled)
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <SourceBadge source={row.source} />
        <code className="text-xs font-mono flex-shrink-0 truncate">{row.modelId}</code>
        {!isEditing && row.displayName !== row.modelId && (
          <span className="text-xs text-muted-foreground truncate">{row.displayName}</span>
        )}
        <div className="flex-1" />
        <Switch
          checked={row.enabled}
          onCheckedChange={v => updateModel.mutate({ id: row.id, patch: { enabled: v } })}
          disabled={updateModel.isPending}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => (isEditing ? cancelEdit() : startEdit(row))}
          aria-label="Edit"
        >
          <Pencil className="size-3" />
        </Button>
        {row.source === 'user' && (
          <Button
            variant="ghost"
            size="xs"
            className={confirmDeleteId === row.id ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}
            onClick={() => {
              if (confirmDeleteId === row.id) {
                deleteModel.mutate(row.id)
              } else {
                setConfirmDeleteId(row.id)
                setTimeout(() => setConfirmDeleteId((c: number | null) => (c === row.id ? null : c)), 3000)
              }
            }}
            disabled={deleteModel.isPending}
            aria-label="Delete"
          >
            <Trash2 className="size-3" />
            {confirmDeleteId === row.id && (
              <span className="ml-1">{t('keys.confirmRemove')}</span>
            )}
          </Button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 pl-1">
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">{t('aliases.title')}</span>
        <Select
          value={row.aliasId == null ? 'none' : String(row.aliasId)}
          onValueChange={v => updateModel.mutate({ id: row.id, patch: { aliasId: v === 'none' ? null : Number(v) } })}
          disabled={updateModel.isPending}
        >
          <SelectTrigger className="h-7 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none" className="text-xs">{t('aliases.none')}</SelectItem>
            {enabledAliases.map(a => (
              <SelectItem key={a.id} value={String(a.id)} className="text-xs">{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {row.aliasId != null && (
          <>
            <span className="text-[11px] text-muted-foreground whitespace-nowrap">{t('aliases.priority')}</span>
            <Input
              key={row.id}
              defaultValue={String(row.aliasPriority ?? 0)}
              onBlur={e => {
                const p = Number(e.target.value)
                const next = Number.isFinite(p) ? Math.trunc(p) : 0
                if (next !== (row.aliasPriority ?? 0)) updateModel.mutate({ id: row.id, patch: { aliasPriority: next } })
              }}
              type="number"
              className="h-7 w-16 text-xs"
            />
          </>
        )}
      </div>
      {isEditing && (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border bg-muted/40 p-3">
          <div className="space-y-1">
            <Label className="text-xs">displayName</Label>
            <Input
              value={editDraft.displayName}
              onChange={e => setEditDraft({ ...editDraft, displayName: e.target.value })}
              className="text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">contextWindow</Label>
            <Input
              value={editDraft.contextWindow}
              onChange={e => setEditDraft({ ...editDraft, contextWindow: e.target.value })}
              type="number"
              className="text-xs"
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={editDraft.supportsVision}
                onCheckedChange={v => setEditDraft({ ...editDraft, supportsVision: v })}
              />
              {t('models.vision')}
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={editDraft.supportsTools}
                onCheckedChange={v => setEditDraft({ ...editDraft, supportsTools: v })}
              />
              {t('models.tools')}
            </label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => submitEdit(row.id)} disabled={updateModel.isPending}>
              {updateModel.isPending ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {row.source !== 'user' && confirmDeleteId === row.id && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {t('models.cannotDeleteCatalog')}
        </div>
      )}
    </div>
  )
}

function SourceBadge({ source }: { source: ModelRow['source'] }) {
  const { t } = useI18n()
  // The badge palette is the only place that branches on source — visually
  // anchors the row so the maintainer can scan the list and know at a glance
  // which rows accept hard-delete and which only accept disable.
  const styles: Record<ModelRow['source'], string> = {
    user: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
    catalog: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30',
    migration: 'bg-muted text-muted-foreground border-border',
  }
  const labels: Record<ModelRow['source'], string> = {
    user: t('models.sourceUser'),
    catalog: t('models.sourceCatalog'),
    migration: t('models.sourceBuiltin'),
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${styles[source]}`}>
      {labels[source]}
    </span>
  )
}
