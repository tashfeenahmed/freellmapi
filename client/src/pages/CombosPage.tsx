import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Layers, Plus, Pencil, Trash2 } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { SortableModelItem } from '@/components/sortable-model-item'
import { apiFetch } from '@/lib/api'
import { buildModelOptions } from '@/lib/model-groups'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { EmptyState } from '@/components/empty-state'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

// ── Types ──────────────────────────────────────────────────────────────────

type ComboStrategy = 'fallback' | 'round-robin' | 'fusion'

interface Combo {
  id: number
  name: string
  description: string
  models: string[]
  strategy: ComboStrategy
  stickyLimit: number
  judgeModel: string | null
  kind: string
  createdAt: string
  updatedAt: string
}

interface CombosResponse {
  combos: Combo[]
}

interface FallbackEntry {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  keyCount: number
}

interface ModelOption {
  value: string
  label: string
  platform: string
  platforms: string[]
  providerCount: number
  sizeTier: number
  intelligenceRank: number
}

// ── ComboForm ────────────────────────────────────────────────────────────

function ComboForm({
  initial,
  onSave,
  onCancel,
  modelOptions,
  saving,
  isCreate,
}: {
  initial?: Partial<Combo>
  onSave: (data: {
    name: string
    description: string
    models: string[]
    strategy: ComboStrategy
    stickyLimit: number
    judgeModel: string | null
  }) => void
  onCancel: () => void
  modelOptions: ModelOption[]
  saving: boolean
  isCreate: boolean
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [models, setModels] = useState<string[]>(initial?.models ?? [])
  const [strategy, setStrategy] = useState<ComboStrategy>(initial?.strategy ?? 'fallback')
  const [stickyLimit, setStickyLimit] = useState(initial?.stickyLimit ?? 1)
  const [judgeModel, setJudgeModel] = useState<string>(initial?.judgeModel ?? '')

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setModels(prev => {
      const oldIndex = prev.findIndex(m => `combo-model-${m}` === active.id)
      const newIndex = prev.findIndex(m => `combo-model-${m}` === over.id)
      if (oldIndex === -1 || newIndex === -1) return prev
      return arrayMove(prev, oldIndex, newIndex)
    })
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      description: description.trim(),
      models,
      strategy,
      stickyLimit,
      judgeModel: judgeModel || null,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Name */}
      <section className="space-y-2">
        <label className="text-sm font-medium">{t('combos.name')}</label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('combos.name')}
          required
          disabled={!isCreate}
          className="max-w-md"
        />
      </section>

      {/* Description */}
      <section className="space-y-2">
        <label className="text-sm font-medium">{t('combos.descriptionLabel')}</label>
        <Textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t('combos.descriptionPlaceholder')}
          rows={2}
          className="max-w-md"
        />
      </section>

      {/* Strategy */}
      <section className="space-y-2">
        <label className="text-sm font-medium">{t('combos.strategy')}</label>
        <Select value={strategy} onValueChange={v => { if (v) setStrategy(v as ComboStrategy) }}>
          <SelectTrigger className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fallback">{t('combos.strategyFallback')}</SelectItem>
            <SelectItem value="round-robin">{t('combos.strategyRoundRobin')}</SelectItem>
            <SelectItem value="fusion">{t('combos.strategyFusion')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {strategy === 'fallback' && t('combos.strategyFallbackHelp')}
          {strategy === 'round-robin' && t('combos.strategyRoundRobinHelp')}
          {strategy === 'fusion' && t('combos.strategyFusionHelp')}
        </p>
      </section>

      {/* Sticky limit (only for round-robin) */}
      {strategy === 'round-robin' && (
        <section className="space-y-2">
          <label className="text-sm font-medium">{t('combos.stickyLimit')}</label>
          <Input
            type="number"
            min={1}
            max={100}
            value={stickyLimit}
            onChange={e => setStickyLimit(Number(e.target.value))}
            className="w-28"
          />
          <p className="text-xs text-muted-foreground">{t('combos.stickyLimitHelp')}</p>
        </section>
      )}

      {/* Judge model (only for fusion) */}
      {strategy === 'fusion' && (
        <section className="space-y-2">
          <label className="text-sm font-medium">{t('combos.judgeModel')}</label>
          <Select value={judgeModel} onValueChange={v => setJudgeModel(v ?? '')}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('combos.judgeAuto')}</SelectItem>
              {modelOptions.map(o => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="flex items-center gap-2">
                    <span>{o.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('combos.judgeModelHelp')}</p>
        </section>
      )}

      {/* Model picker — ordered list with drag-to-reorder */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label className="text-sm font-medium">{t('combos.models')}</label>
          <span className="text-xs text-muted-foreground">
            {t('combos.selectedCount', { count: models.length })}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('combos.modelsHelp')}</p>

        {/* Selected models — sortable */}
        {models.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={models.map(m => `combo-model-${m}`)}
              strategy={verticalListSortingStrategy}
            >
              <div className="rounded-xl border overflow-hidden">
                {models.map(modelId => {
                  const opt = modelOptions.find(o => o.value === modelId)
                  return (
                    <SortableModelItem
                      key={`combo-model-${modelId}`}
                      id={`combo-model-${modelId}`}
                      modelId={modelId}
                      label={opt?.label ?? modelId}
                      platform={opt?.platform ?? modelId}
                      providerCount={opt?.providerCount ?? 1}
                      onRemove={(mid) => setModels(prev => prev.filter(m => m !== mid))}
                    />
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {/* Add models — available models not yet in the combo */}
        {modelOptions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('fusion.noModels')}</p>
        ) : (
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground transition-colors list-none flex items-center gap-1.5">
              <Plus className="size-3.5" />
              {t('combos.addModels')}
            </summary>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border divide-y">
              {modelOptions
                .filter(o => !models.includes(o.value))
                .map(o => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setModels(prev => [...prev, o.value])}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30"
                  >
                    <Plus className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="text-sm font-medium">{o.label}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">{o.value}</span>
                    </span>
                    <Badge variant="secondary" className="text-[10px]">
                      {o.providerCount > 1
                        ? t('models.providerCount', { count: o.providerCount })
                        : o.platform}
                    </Badge>
                  </button>
                ))}
            </div>
          </details>
        )}
      </section>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving || !name.trim() || models.length === 0}>
          {saving ? t('common.loading') : isCreate ? t('combos.create') : t('combos.save')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('combos.cancel')}
        </Button>
      </div>
    </form>
  )
}

// ── ComboCard ──────────────────────────────────────────────────────────────

function ComboCard({
  combo,
  onEdit,
  onDelete,
}: {
  combo: Combo
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const strategyLabel = {
    fallback: t('combos.strategyFallback'),
    'round-robin': t('combos.strategyRoundRobin'),
    fusion: t('combos.strategyFusion'),
  }[combo.strategy]

  return (
    <div className="rounded-xl border p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{combo.name}</h3>
          {combo.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{combo.description}</p>
          )}
        </div>
        <Badge variant="secondary" className="shrink-0 text-[10px]">{strategyLabel}</Badge>
      </div>

      {/* Model chips */}
      <div className="flex flex-wrap gap-1">
        {combo.models.map(m => (
          <Badge key={m} variant="outline" className="text-[10px] font-mono">{m}</Badge>
        ))}
      </div>

      {/* Usage hint */}
      <pre className="overflow-x-auto rounded-lg bg-muted/30 p-2 text-[11px] font-mono border text-muted-foreground">
        model: &quot;{combo.name}&quot;
      </pre>

      {/* Actions */}
      <div className="flex items-center gap-1 pt-1 border-t">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5 mr-1" />
          {t('combos.editCombo')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-destructive hover:text-destructive">
          <Trash2 className="size-3.5 mr-1" />
          {t('combos.deleteCombo')}
        </Button>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function CombosPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Fetch combos
  const { data: combosData, isLoading: combosLoading } = useQuery<CombosResponse>({
    queryKey: ['combos'],
    queryFn: () => apiFetch('/api/combos'),
  })

  // Fetch fallback entries for the model picker
  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: unify } = useQuery<{ enabled: boolean }>({
    queryKey: ['unify'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })
  const unifyOn = unify?.enabled ?? true

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  const modelOptions = buildModelOptions(availableModels, unifyOn)

  // Form state: null = hidden, 'new' = create, object = edit
  const [editingCombo, setEditingCombo] = useState<Combo | 'new' | null>(null)

  // Server expects snake_case keys (sticky_limit, judge_model) while the form
  // uses camelCase (stickyLimit, judgeModel). Map before sending.
  const toApiPayload = (body: {
    name: string
    description: string
    models: string[]
    strategy: ComboStrategy
    stickyLimit: number
    judgeModel: string | null
  }) => JSON.stringify({
    name: body.name,
    description: body.description,
    models: body.models,
    strategy: body.strategy,
    sticky_limit: body.stickyLimit,
    judge_model: body.judgeModel,
  })

  // Create mutation
  const createMutation = useMutation({
    mutationFn: (body: {
      name: string
      description: string
      models: string[]
      strategy: ComboStrategy
      stickyLimit: number
      judgeModel: string | null
    }) => apiFetch('/api/combos', { method: 'POST', body: toApiPayload(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['combos'] })
      setEditingCombo(null)
      toast.success(t('combos.created'))
    },
    onError: (err) => {
      toast.error(`${t('combos.createError')}: ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number
      data: {
        name?: string
        description?: string
        models?: string[]
        strategy?: ComboStrategy
        stickyLimit?: number
        judgeModel?: string | null
      }
    }) => {
      // Map camelCase form fields → snake_case server keys; drop camelCase keys
      const { stickyLimit, judgeModel, ...rest } = data
      return apiFetch(`/api/combos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...rest,
          sticky_limit: stickyLimit,
          judge_model: judgeModel,
        }),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['combos'] })
      setEditingCombo(null)
      toast.success(t('combos.updated'))
    },
    onError: (err) => {
      toast.error(`${t('combos.updateError')}: ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/combos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['combos'] })
      toast.success(t('combos.deleted'))
    },
    onError: (err) => {
      toast.error(`${t('combos.deleteError')}: ${err instanceof Error ? err.message : String(err)}`)
    },
  })

  const handleSave = (data: Parameters<typeof createMutation.mutate>[0]) => {
    if (editingCombo === 'new') {
      createMutation.mutate(data)
    } else if (editingCombo) {
      updateMutation.mutate({ id: editingCombo.id, data })
    }
  }

  const handleDelete = (combo: Combo) => {
    if (window.confirm(t('combos.deleteConfirm', { name: combo.name }))) {
      deleteMutation.mutate(combo.id)
    }
  }

  const combos = combosData?.combos ?? []
  const saving = createMutation.isPending || updateMutation.isPending

  return (
    <div>
      <PageHeader
        title={t('combos.title')}
        description={t('combos.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      {/* Form (create/edit) */}
      {editingCombo && (
        <div className="mb-8 rounded-xl border p-6">
          <h2 className="text-lg font-semibold mb-4">
            {editingCombo === 'new' ? t('combos.addCombo') : t('combos.editCombo')}
          </h2>
          <ComboForm
            initial={editingCombo === 'new' ? undefined : editingCombo}
            onSave={handleSave}
            onCancel={() => setEditingCombo(null)}
            modelOptions={modelOptions}
            saving={saving}
            isCreate={editingCombo === 'new'}
          />
        </div>
      )}

      {/* Combo list */}
      {combosLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : combos.length === 0 && !editingCombo ? (
        <div className="flex flex-col items-center gap-4 py-12">
          <EmptyState
            icon={Layers}
            title={t('combos.noCombos')}
            description={t('combos.noCombosDesc')}
          />
          <Button onClick={() => setEditingCombo('new')}>
            <Plus className="size-4 mr-1" />
            {t('combos.addCombo')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {!editingCombo && (
            <Button onClick={() => setEditingCombo('new')}>
              <Plus className="size-4 mr-1" />
              {t('combos.addCombo')}
            </Button>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {combos.map(combo => (
              <ComboCard
                key={combo.id}
                combo={combo}
                onEdit={() => setEditingCombo(combo)}
                onDelete={() => handleDelete(combo)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}