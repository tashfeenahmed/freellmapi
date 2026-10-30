import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, Layers } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { dragDots } from '@/components/model-table'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { EmptyState } from '@/components/empty-state'
import { CardSkeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { UsageSummaryCard } from '@/components/usage-summary-card'
import { useI18n } from '@/i18n'

interface ProviderEntry {
  id: number
  platform: string
  modelId: string
  displayName: string
  priority: number
  enabled: boolean
  quotaLabel: string
  keyCount: number
  isCustom?: boolean
}

interface Family {
  family: string
  dimensions: number
  maxInputTokens: number | null
  isDefault: boolean
  providers: ProviderEntry[]
}

interface EmbeddingsData {
  defaultFamily: string
  families: Family[]
}

interface UsageData {
  families: {
    family: string
    requestsToday: number
    tokensMonth: number
    platform?: string | null
    quotaLabel?: string | null
  }[]
  totalTokensMonth?: number
  totalRequestsToday?: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// One provider row: draggable (same handle as the chat routing table) plus
// arrow buttons for one-step keyboard-free moves.
function SortableProviderRow({
  provider: p,
  index: i,
  count,
  onMove,
  onToggle,
  onDelete,
  deleting,
}: {
  provider: ProviderEntry
  index: number
  count: number
  onMove: (dir: -1 | 1) => void
  onToggle: (checked: boolean) => void
  onDelete: () => void
  deleting: boolean
}) {
  const { t } = useI18n()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 py-2 bg-card ${p.enabled ? '' : 'opacity-50'} ${isDragging ? 'opacity-50 relative z-10' : ''}`}
    >
      {/* Always a handle, even with a single provider in the family: the drag may
          target another family card, which is how a row joins a different chain. */}
      <button
        {...attributes}
        {...listeners}
        aria-label={t('embeddings.dragToReorder')}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
      >
        {dragDots}
      </button>
      <span className="w-5 text-center font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{p.platform}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{p.modelId}</span>
          {p.keyCount === 0 && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
              {t('models.noKey')}
            </span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground/70">{p.quotaLabel}</div>
      </div>
      {count > 1 && (
        <div className="flex gap-0.5">
          <button
            onClick={() => onMove(-1)}
            disabled={i === 0}
            aria-label={t('embeddings.moveUp')}
            className="rounded-md p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-25 transition-colors"
          >
            <ArrowUp className="size-3.5" />
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={i === count - 1}
            aria-label={t('embeddings.moveDown')}
            className="rounded-md p-1 text-muted-foreground/60 hover:text-foreground disabled:opacity-25 transition-colors"
          >
            <ArrowDown className="size-3.5" />
          </button>
        </div>
      )}
      <Switch checked={p.enabled} onCheckedChange={onToggle} />
      {p.isCustom && (
        <ConfirmButton
          className="text-muted-foreground hover:text-destructive"
          onConfirm={onDelete}
          disabled={deleting}
        >
          {t('common.remove')}
        </ConfirmButton>
      )}
    </div>
  )
}

export default function EmbeddingsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Local unsaved edits, same pattern as the chat fallback page.
  const [localFamilies, setLocalFamilies] = useState<Family[] | null>(null)
  const [localDefault, setLocalDefault] = useState<string | null>(null)

  const { data, isLoading } = useQuery<EmbeddingsData>({
    queryKey: ['embeddings'],
    queryFn: () => apiFetch('/api/embeddings'),
  })

  const { data: usage } = useQuery<UsageData>({
    queryKey: ['embeddings', 'usage'],
    queryFn: () => apiFetch('/api/embeddings/usage'),
    refetchInterval: 30_000,
  })
  const usageByFamily = new Map((usage?.families ?? []).map(u => [u.family, u]))

  const saveMutation = useMutation({
    mutationFn: (body: {
      defaultFamily?: string
      providers?: { id: number; priority: number; enabled: boolean; family?: string }[]
    }) => apiFetch('/api/embeddings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      setLocalFamilies(null)
      setLocalDefault(null)
    },
  })

  const deleteCustom = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/embeddings/custom/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings', 'usage'] })
      setLocalFamilies(null)
    },
  })

  const families = localFamilies ?? data?.families ?? []
  const defaultFamily = localDefault ?? data?.defaultFamily ?? ''
  const hasChanges = localFamilies !== null || localDefault !== null

  function updateProvider(familyName: string, id: number, patch: Partial<ProviderEntry>) {
    setLocalFamilies(families.map(f =>
      f.family === familyName
        ? { ...f, providers: f.providers.map(p => (p.id === id ? { ...p, ...patch } : p)) }
        : f,
    ))
  }

  function moveProvider(familyName: string, index: number, dir: -1 | 1) {
    setLocalFamilies(families.map(f => {
      if (f.family !== familyName) return f
      const list = [...f.providers]
      const j = index + dir
      if (j < 0 || j >= list.length) return f
      ;[list[index], list[j]] = [list[j], list[index]]
      return { ...f, providers: list.map((p, i) => ({ ...p, priority: i + 1 })) }
    }))
  }

  // Same reorder metaphor as the chat routing table: drag anywhere, arrows for
  // one-step moves. Both buffer into the same unsaved-changes bar.
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // One DndContext for every family, so a row can be dropped on a provider that
  // lives in another family card. Per-family contexts made that impossible: a
  // context only sees its own droppables.
  const [dragFrom, setDragFrom] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  function familyOfProvider(id: number): string | null {
    return families.find(f => f.providers.some(p => p.id === id))?.family ?? null
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setDragFrom(null)
    setDragOver(null)
    if (!over || active.id === over.id) return
    const activeId = Number(active.id)
    const overId = Number(over.id)
    const from = families.find(f => f.providers.some(p => p.id === activeId))
    const to = families.find(f => f.providers.some(p => p.id === overId))
    if (!from || !to) return

    if (from.family === to.family) {
      setLocalFamilies(families.map(f => {
        if (f.family !== from.family) return f
        const oldIndex = f.providers.findIndex(p => p.id === activeId)
        const newIndex = f.providers.findIndex(p => p.id === overId)
        if (oldIndex < 0 || newIndex < 0) return f
        return { ...f, providers: arrayMove(f.providers, oldIndex, newIndex).map((p, i) => ({ ...p, priority: i + 1 })) }
      }))
      return
    }

    // Dropped on another family: the row joins that chain. It lands at the end —
    // the same place the server appends it, so the buffered view and the saved
    // result agree, and the arrows order it from there.
    const moving = from.providers.find(p => p.id === activeId)
    if (!moving) return
    setLocalFamilies(families.map(f => {
      if (f.family === from.family) {
        return { ...f, providers: f.providers.filter(p => p.id !== activeId).map((p, i) => ({ ...p, priority: i + 1 })) }
      }
      if (f.family === to.family) {
        const nextPriority = f.providers.reduce((max, p) => Math.max(max, p.priority), 0) + 1
        return { ...f, providers: [...f.providers, { ...moving, priority: nextPriority }] }
      }
      return f
    }))
  }

  function handleSave() {
    // `family` travels only for rows the drag actually moved: the server treats its
    // absence as "unchanged" and keeps the plain priority/enabled path untouched.
    const serverFamilyOf = new Map<number, string>()
    data?.families.forEach(f => f.providers.forEach(p => serverFamilyOf.set(p.id, f.family)))
    saveMutation.mutate({
      ...(localDefault !== null ? { defaultFamily: localDefault } : {}),
      ...(localFamilies !== null
        ? {
          providers: families.flatMap(f => f.providers.map(p => {
            const origin = serverFamilyOf.get(p.id)
            return {
              id: p.id,
              priority: p.priority,
              enabled: p.enabled,
              ...(origin !== undefined && origin !== f.family ? { family: f.family } : {}),
            }
          })),
        }
        : {}),
    })
  }

  function discard() {
    setLocalFamilies(null)
    setLocalDefault(null)
  }

  return (
    <div>
      <PageHeader
        title={t('embeddings.title')}
        description={t('embeddings.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        <p className="text-xs text-muted-foreground">
          {t('embeddings.autoDescription')}
        </p>

        {usage && usage.families.length > 0 && (
          <UsageSummaryCard
            unit="tokens"
            total={usage.totalTokensMonth ?? 0}
            requestsToday={usage.totalRequestsToday ?? 0}
            rows={usage.families.map(f => ({
              label: f.family,
              platform: f.platform ?? null,
              quotaLabel: f.quotaLabel ?? null,
              amount: f.tokensMonth,
              requestsToday: f.requestsToday,
            }))}
          />
        )}

        {isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : families.length === 0 ? (
          <EmptyState
            icon={Layers}
            title={t('embeddings.emptyTitle')}
            description={t('embeddings.emptyDesc')}
            action={
              <Link to="/keys">
                <Button size="sm">{t('setup.step1Cta')}</Button>
              </Link>
            }
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={e => {
              setDragFrom(familyOfProvider(Number(e.active.id)))
              setDragOver(null)
            }}
            onDragOver={e => setDragOver(e.over ? familyOfProvider(Number(e.over.id)) : null)}
            onDragCancel={() => {
              setDragFrom(null)
              setDragOver(null)
            }}
            onDragEnd={handleDragEnd}
          >
            {families.map(f => {
              const u = usageByFamily.get(f.family)
              const noKeys = f.providers.every(p => p.keyCount === 0)
              // Highlight only where the drop would actually move the row: a
              // same-family drag is already legible from the sorting itself.
              const isDropTarget = dragFrom !== null && dragOver === f.family && dragFrom !== f.family
              return (
                <section
                  key={f.family}
                  className={`rounded-3xl border bg-card p-5 transition-shadow ${noKeys ? 'opacity-60' : ''} ${isDropTarget ? 'ring-2 ring-foreground/25' : ''}`}
                >
                  <div className="flex items-baseline justify-between gap-4 mb-3 flex-wrap">
                    <div className="flex items-baseline gap-2.5 min-w-0">
                      <Link to={`/models/embeddings/${encodeURIComponent(f.family)}`} className="text-sm font-medium font-mono truncate hover:underline">{f.family}</Link>
                      <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground tabular-nums">
                        {f.dimensions}d
                      </span>
                      {f.maxInputTokens && (
                        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                          {t('embeddings.tokMax', { tokens: formatTokens(f.maxInputTokens) })}
                        </span>
                      )}
                      {f.family === defaultFamily ? (
                        <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-foreground text-background font-medium">
                          {t('embeddings.defaultBadge')}
                        </span>
                      ) : (
                        <button
                          onClick={() => setLocalDefault(f.family)}
                          className="text-[11px] text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2 transition-colors"
                        >
                          {t('embeddings.makeDefault')}
                        </button>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {u ? <>{t('embeddings.usageToday', { count: u.requestsToday })} · {t('embeddings.usageMonth', { count: formatTokens(u.tokensMonth) })}</> : '—'}
                    </span>
                  </div>

                  <SortableContext items={f.providers.map(p => p.id)} strategy={verticalListSortingStrategy}>
                    <div className="divide-y">
                      {f.providers.map((p, i) => (
                        <SortableProviderRow
                          key={p.id}
                          provider={p}
                          index={i}
                          count={f.providers.length}
                          onMove={dir => moveProvider(f.family, i, dir)}
                          onToggle={c => updateProvider(f.family, p.id, { enabled: c })}
                          onDelete={() => deleteCustom.mutate(p.id)}
                          deleting={deleteCustom.isPending}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </section>
              )
            })}
          </DndContext>
        )}

        <FloatingBar show={hasChanges}>
          <span className="text-xs text-muted-foreground">{t('embeddings.unsavedChanges')}</span>
          <Button variant="outline" size="sm" onClick={discard}>{t('common.discard')}</Button>
          <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? t('embeddings.savingChanges') : t('embeddings.saveChanges')}
          </Button>
        </FloatingBar>
      </div>
    </div>
  )
}
