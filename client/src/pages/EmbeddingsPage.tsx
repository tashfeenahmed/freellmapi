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
  families: { family: string; requestsToday: number; tokensMonth: number }[]
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
      {count > 1 && (
        <button
          {...attributes}
          {...listeners}
          aria-label={t('embeddings.dragToReorder')}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          {dragDots}
        </button>
      )}
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
    mutationFn: (body: { defaultFamily?: string; providers?: { id: number; priority: number; enabled: boolean }[] }) =>
      apiFetch('/api/embeddings', { method: 'PUT', body: JSON.stringify(body) }),
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

  function handleDragEnd(familyName: string, event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setLocalFamilies(families.map(f => {
      if (f.family !== familyName) return f
      const oldIndex = f.providers.findIndex(p => p.id === active.id)
      const newIndex = f.providers.findIndex(p => p.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return f
      return { ...f, providers: arrayMove(f.providers, oldIndex, newIndex).map((p, i) => ({ ...p, priority: i + 1 })) }
    }))
  }

  function handleSave() {
    saveMutation.mutate({
      ...(localDefault !== null ? { defaultFamily: localDefault } : {}),
      ...(localFamilies !== null
        ? { providers: families.flatMap(f => f.providers.map(p => ({ id: p.id, priority: p.priority, enabled: p.enabled }))) }
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
          families.map(f => {
            const u = usageByFamily.get(f.family)
            const noKeys = f.providers.every(p => p.keyCount === 0)
            return (
              <section key={f.family} className={`rounded-3xl border bg-card p-5 ${noKeys ? 'opacity-60' : ''}`}>
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

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={e => handleDragEnd(f.family, e)}>
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
                </DndContext>
              </section>
            )
          })
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
