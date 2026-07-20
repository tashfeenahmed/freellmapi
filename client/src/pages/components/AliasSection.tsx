import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import type { Platform, AliasLevel } from '../../../../shared/types'
import { useI18n } from '@/i18n'

// Logical-model (alias) management section. Lives inside ManageModelsDrawer
// per design decision 9 - one place to create/edit aliases and inspect their
// member models. Alias-level routing entry points (high-level/middle-level/
// low-level) are reserved names, enforced server-side; the create/rename form
// surfaces the 400/409 as an inline error.

type Level = AliasLevel

interface AliasRow {
  id: number
  name: string
  level: Level
  priority: number
  enabled: boolean
  createdAt: string
  memberModelIds: number[]
}

// Minimal shape of /api/models rows we need to render alias members.
interface MemberModel {
  id: number
  platform: Platform
  modelId: string
  aliasPriority: number
}

const LEVELS: Level[] = ['high', 'middle', 'low']

const LEVEL_BADGE: Record<Level, string> = {
  high: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30',
  middle: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30',
}

export function AliasSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: aliases = [] } = useQuery<AliasRow[]>({
    queryKey: ['aliases'],
    queryFn: () => apiFetch('/api/aliases'),
  })
  const { data: allModels = [] } = useQuery<MemberModel[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
  })

  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLevel, setNewLevel] = useState<Level>('low')
  const [newPriority, setNewPriority] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<{ name: string; level: Level; priority: string }>({
    name: '',
    level: 'low',
    priority: '',
  })
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['aliases'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const createAlias = useMutation({
    mutationFn: (payload: { name: string; level: Level; priority?: number }) =>
      apiFetch('/api/aliases', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidate()
      setShowAdd(false)
      setNewName('')
      setNewLevel('low')
      setNewPriority('')
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to create alias'),
  })

  const updateAlias = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiFetch(`/api/aliases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to update alias'),
  })

  const deleteAlias = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      setExpandedId(null)
      setError(null)
    },
    onError: (e: any) => setError(e?.message ?? 'Failed to delete alias'),
  })

  function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    const payload: { name: string; level: Level; priority?: number } = { name, level: newLevel }
    const p = Number(newPriority)
    if (newPriority && Number.isFinite(p)) payload.priority = Math.trunc(p)
    createAlias.mutate(payload)
  }

  function startEdit(a: AliasRow) {
    setEditingId(a.id)
    setEditDraft({
      name: a.name,
      level: a.level,
      priority: String(a.priority),
    })
  }

  function submitEdit(id: number) {
    const patch: Record<string, unknown> = {
      name: editDraft.name.trim(),
      level: editDraft.level,
    }
    const p = Number(editDraft.priority)
    patch.priority = editDraft.priority === '' || !Number.isFinite(p) ? 0 : Math.trunc(p)
    updateAlias.mutate({ id, patch })
  }

  const modelsById = new Map(allModels.map(m => [m.id, m]))

  return (
    <div className="rounded-2xl border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b bg-muted/30">
        <h3 className="text-xs font-medium">{t('aliases.title')}</h3>
        {!showAdd && (
          <Button variant="ghost" size="xs" onClick={() => setShowAdd(true)}>
            + {t('aliases.add')}
          </Button>
        )}
      </div>

      {error && (
        <div className="mx-4 my-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {showAdd && (
        <form onSubmit={submitAdd} className="px-4 py-3 space-y-3 border-b bg-muted/20">
          <div className="grid grid-cols-1 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('aliases.name')}</Label>
              <Input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="glm5.2"
                className="font-mono text-xs"
                autoFocus
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('aliases.level')}</Label>
                <Select value={newLevel} onValueChange={v => setNewLevel(v as Level)}>
                  <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LEVELS.map(l => (
                      <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('aliases.priority')}</Label>
                <Input
                  value={newPriority}
                  onChange={e => setNewPriority(e.target.value)}
                  placeholder="0"
                  type="number"
                  className="text-xs"
                />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={createAlias.isPending || !newName.trim()}>
              {createAlias.isPending ? t('common.saving') : t('common.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setShowAdd(false); setError(null) }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}

      {aliases.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">{t('common.noData')}</div>
      ) : (
        <div className="divide-y">
          {aliases.map(a => {
            const isEditing = editingId === a.id
            const isExpanded = expandedId === a.id
            const members = a.memberModelIds
              .map(id => modelsById.get(id))
              .filter((m): m is MemberModel => !!m)
            return (
              <div key={a.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex-shrink-0"
                    onClick={() => setExpandedId(isExpanded ? null : a.id)}
                    aria-label="Toggle members"
                  >
                    {isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  {!isEditing && (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${LEVEL_BADGE[a.level]}`}>
                      {a.level}
                    </span>
                  )}
                  {!isEditing && (
                    <code className="text-xs font-mono flex-shrink-0 truncate">{a.name}</code>
                  )}
                  {!isEditing && (
                    <span className="text-[11px] text-muted-foreground">p:{a.priority}</span>
                  )}
                  <div className="flex-1" />
                  {!isEditing && (
                    <Switch
                      checked={a.enabled}
                      onCheckedChange={v => updateAlias.mutate({ id: a.id, patch: { enabled: v } })}
                      disabled={updateAlias.isPending}
                    />
                  )}
                  {!isEditing && (
                    <Button variant="ghost" size="xs" onClick={() => startEdit(a)} aria-label="Edit">
                      <Pencil className="size-3" />
                    </Button>
                  )}
                  {!isEditing && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className={confirmDeleteId === a.id ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}
                      onClick={() => {
                        if (confirmDeleteId === a.id) {
                          deleteAlias.mutate(a.id)
                        } else {
                          setConfirmDeleteId(a.id)
                          setTimeout(() => setConfirmDeleteId((c: number | null) => (c === a.id ? null : c)), 3000)
                        }
                      }}
                      disabled={deleteAlias.isPending}
                      aria-label="Delete"
                    >
                      <Trash2 className="size-3" />
                      {confirmDeleteId === a.id && <span className="ml-1">{t('keys.confirmRemove')}</span>}
                    </Button>
                  )}
                </div>

                {isEditing && (
                  <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border bg-muted/40 p-3">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('aliases.name')}</Label>
                      <Input
                        value={editDraft.name}
                        onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">{t('aliases.level')}</Label>
                        <Select value={editDraft.level} onValueChange={v => setEditDraft({ ...editDraft, level: v as Level })}>
                          <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {LEVELS.map(l => (
                              <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t('aliases.priority')}</Label>
                        <Input
                          value={editDraft.priority}
                          onChange={e => setEditDraft({ ...editDraft, priority: e.target.value })}
                          type="number"
                          className="text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => submitEdit(a.id)} disabled={updateAlias.isPending}>
                        {updateAlias.isPending ? t('common.saving') : t('common.save')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                {isExpanded && !isEditing && (
                  <div className="mt-2 pl-6 space-y-1">
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                      {t('aliases.members')} ({members.length})
                    </div>
                    {members.length === 0 ? (
                      <div className="text-[11px] text-muted-foreground">{t('aliases.noMembers')}</div>
                    ) : (
                      members.map(m => (
                        <div key={m.id} className="flex items-center gap-2 text-[11px]">
                          <span className="inline-flex items-center rounded border px-1.5 py-0.5 font-medium uppercase text-muted-foreground">
                            {m.platform}
                          </span>
                          <code className="font-mono truncate">{m.modelId}</code>
                          <span className="text-muted-foreground">p:{m.aliasPriority}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
