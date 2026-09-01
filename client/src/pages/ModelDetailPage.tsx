import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Merge, Save, Split, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { addAlias, aliasesFor, removeAlias } from '@/lib/alias-merge'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { ModelTableHead, RateLimitBadge, RowContent } from '@/components/model-table'
import {
  groupQuotaBadge,
  isMemberSplit,
  memberEndpointTitle,
  memberOverrideKey,
  memberProviderLabel,
  providerPinId,
  splitsWithoutMember,
  type FallbackEntry,
  type RateLimitUsageData,
  type RoutingData,
  type Row,
} from '@/lib/routing'
import {
  modelSettingsForm,
  reviewModelSettings,
  RANK_MAX,
  RANK_MIN,
  SIZE_LABELS,
  type ModelSettingsPatch,
  type ModelSettingsSource,
} from '@/lib/model-settings'

// The persisted unify overrides (see server model-groups.ts). `splits` forces a
// "platform:model_id" member out of its computed group into its own entry.
type UnifyOverrides = {
  merges: { into: string; keys: string[] }[]
  splits: { member: string; groupKey?: string }[]
}

// What the per-provider split control should do for one member row.
export type SplitAction = {
  kind: 'split' | 'undo'
  pending: boolean
  onClick: () => void
}

// One model's own page: lists every provider that serves it (this model now
// fails over across these providers). Reached from the Models list; replaces the
// old inline group expansion.
export default function ModelDetailPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const canonicalId = id ? decodeURIComponent(id) : ''
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  const { data: unify } = useQuery<{ enabled: boolean; overrides: UnifyOverrides }>({
    queryKey: ['unify'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })
  // Time-window rate-limit usage (#876), the same shared query the Models table
  // uses — one poll for the page, read per row from a map.
  const { data: rateLimitUsage } = useQuery<RateLimitUsageData>({
    queryKey: ['fallback', 'rate-limit-usage'],
    queryFn: () => apiFetch('/api/fallback/rate-limit-usage'),
    refetchInterval: 15_000,
  })
  const rateUsageByModel = useMemo(
    () => new Map((rateLimitUsage?.rows ?? []).map(r => [r.modelDbId, r])),
    [rateLimitUsage],
  )

  // Toggling a provider persists immediately (no save bar on this page): send the
  // full entries list with this one flipped, then refresh.
  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })
  const modelPatchMutation = useMutation({
    mutationFn: ({ modelDbId, patch }: { modelDbId: number; patch: ModelSettingsPatch }) =>
      apiFetch(`/api/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })
  const modelDeleteMutation = useMutation({
    mutationFn: (modelDbId: number) => apiFetch(`/api/models/${modelDbId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  // Split a provider's copy out of its unified model (or merge it back).
  // PUT /api/settings/unify replaces the whole overrides object, so send the
  // current merges untouched with the adjusted splits list.
  const splitMutation = useMutation({
    mutationFn: (splits: UnifyOverrides['splits']) =>
      apiFetch('/api/settings/unify', {
        method: 'PUT',
        body: JSON.stringify({ overrides: { merges: unify?.overrides.merges ?? [], splits } }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unify'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  // #790: merge a custom provider's model alias into THIS unified model, so a
  // request for the primary model id is served through the alias too. Same
  // whole-overrides PUT as splits; only the merges list changes.
  const [aliasInput, setAliasInput] = useState('')
  const mergeMutation = useMutation({
    mutationFn: (merges: UnifyOverrides['merges']) =>
      apiFetch('/api/settings/unify', {
        method: 'PUT',
        body: JSON.stringify({ overrides: { merges, splits: unify?.overrides.splits ?? [] } }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unify'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      setAliasInput('')
    },
  })

  const splits = unify?.overrides.splits ?? []
  // New splits are written against ONE row: an unqualified "platform:modelId"
  // matches every relay that serves the id, so splitting one relay's card used
  // to move both (#651). Reading accepts the plain form too, so a split saved
  // before that is still recognised — and still undoable.
  function splitActionFor(m: Row, memberCount: number): SplitAction | undefined {
    if (!unify) return undefined
    // Checked before the member-count guard on purpose: a split row is usually
    // ALONE in its group, and that is exactly the row that needs the undo.
    if (isMemberSplit(splits, m)) {
      return {
        kind: 'undo',
        pending: splitMutation.isPending,
        onClick: () => splitMutation.mutate(splitsWithoutMember(splits, m)),
      }
    }
    if (memberCount < 2) return undefined
    return {
      kind: 'split',
      pending: splitMutation.isPending,
      onClick: () => splitMutation.mutate([...splits, { member: memberOverrideKey(m) }]),
    }
  }

  const isManual = (routing?.strategy ?? 'balanced') === 'priority'
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))

  // Providers serving this model: configured rows whose group matches the id
  // (canonicalId, or the bare model id for an ungrouped model).
  const members: Row[] = entries
    .filter(e => e.keyCount > 0 && (e.canonicalId ?? e.modelId) === canonicalId)
    .map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))
    .sort((a, b) => (isManual ? a.priority - b.priority : (b.score ?? 0) - (a.score ?? 0)))
  // Endpoint disambiguation keys on (platform, model_id) across EVERY configured
  // row — a relay whose copy was renamed sits in a DIFFERENT display group, so
  // `members` is not a complete sibling set and scoping to it would hide the
  // endpoint exactly when two relays collide (#651).
  const siblings: Row[] = entries as Row[]

  function handleToggle(modelDbId: number, enabled: boolean) {
    saveMutation.mutate(entries.map(e => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId === modelDbId ? enabled : e.enabled,
    })))
  }

  const label = members[0]?.groupLabel ?? members[0]?.displayName ?? canonicalId
  const quota = members.length ? groupQuotaBadge(members, t) : null
  const vision = members.some(m => m.supportsVision)
  const tools = members.some(m => m.supportsTools)

  // #790: the aliases merged INTO this group. Every edit is expressed against
  // the full overrides list (see lib/alias-merge) — the visible rows are only
  // this group's slice, so editing by row position would hit other groups.
  const merges = useMemo(() => unify?.overrides.merges ?? [], [unify])
  const groupAliases = useMemo(() => aliasesFor(merges, label), [merges, label])
  const submitAlias = () => {
    if (!aliasInput.trim()) return
    mergeMutation.mutate(addAlias(merges, label, aliasInput))
  }

  // A ready-to-run request referencing this model by its unified id, so it fails
  // over across every provider above. Same base-URL derivation as the Keys page.
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
  const snippet = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${keyData?.apiKey || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${canonicalId}",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`

  return (
    <div>
      <PageHeader title={label} description={t('models.providersHeading')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-6">
        <Link to="/models/chat" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t('models.backToModels')}
        </Link>

        {isLoading ? (
          <TableSkeleton rows={3} />
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            {/* Summary badges. The canonical (unified) model id leads: it is the
                id callers actually put in a request body, and it was previously
                only reachable via the hover copy button in the Models table
                (#725, #708). */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground">
                <code className="min-w-0 truncate font-mono">{canonicalId}</code>
                <CopyButton text={canonicalId} label={t('models.copyModelId')} className="size-4 shrink-0 border-0 bg-transparent" />
              </span>
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: members.length })}</span>
              {quota && <span title={quota.title} className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground tabular-nums">{quota.text}</span>}
              <RateLimitBadge size="md" rows={members.flatMap(m => rateUsageByModel.get(m.modelDbId) ?? [])} />
              {vision && <span title={t('models.visionTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>}
              {tools && <span title={t('models.toolsTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>}
            </div>

            {/* Per-provider stats (same columns as the Models table) */}
            <div className="rounded-2xl border overflow-x-auto">
              <table className="w-full text-sm">
                <ModelTableHead />
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.modelDbId} className={`border-b last:border-0 ${m.enabled ? '' : 'opacity-50'}`}>
                      <RowContent row={m} rank={i + 1} draggable={false} onToggle={handleToggle} providerName={memberProviderLabel(m, siblings)} providerTitle={memberEndpointTitle(m, siblings)} rateUsage={rateUsageByModel.get(m.modelDbId)} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-2xl border bg-card p-4">
              <div className="mb-3">
                <h2 className="text-sm font-medium">{t('models.settingsHeading')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('models.settingsHint')}</p>
              </div>
              <div className="space-y-3">
                {members.map(m => (
                  <ProviderSettingsRow
                    key={m.modelDbId}
                    model={m}
                    endpointLabel={memberProviderLabel(m, siblings)}
                    endpointTitle={memberEndpointTitle(m, siblings)}
                    saving={modelPatchMutation.isPending && modelPatchMutation.variables?.modelDbId === m.modelDbId}
                    deleting={modelDeleteMutation.isPending && modelDeleteMutation.variables === m.modelDbId}
                    onSave={(patch) => modelPatchMutation.mutate({ modelDbId: m.modelDbId, patch })}
                    onDelete={() => modelDeleteMutation.mutate(m.modelDbId)}
                    splitAction={splitActionFor(m, members.length)}
                  />
                ))}
              </div>
            </div>

            {/* The provider-specific model id to send if you want to pin one provider. */}
            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.providerIdsHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.providerIdsHint')}</p>
              <div className="space-y-1.5">
                {members.map(m => (
                  <div key={m.modelDbId} className="flex items-center gap-2 text-xs">
                    <span className="w-28 max-w-[16rem] shrink-0 basis-auto truncate text-muted-foreground sm:w-auto sm:min-w-28" title={memberEndpointTitle(m, siblings)}>
                      {memberProviderLabel(m, siblings)}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{providerPinId(m, siblings)}</code>
                    <Tooltip text={t('models.copyModelName')}>
                      <CopyButton text={providerPinId(m, siblings)} label={t('models.copyModelName')} className="border-0 bg-transparent" />
                    </Tooltip>
                  </div>
                ))}
              </div>
            </div>

            {/* #790: merge a custom provider's model alias into this unified
                model, so requests for the primary model id are served through
                the alias too. Same overrides store as the split control. */}
            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.aliasMergeHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.aliasMergeHint')}</p>
              <div className="flex items-center gap-2">
                <Input
                  value={aliasInput}
                  onChange={e => setAliasInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitAlias() } }}
                  placeholder="custom:my-alias"
                  className="font-mono text-xs"
                  aria-label={t('models.aliasMergeHeading')}
                />
                <Button type="button" size="sm" disabled={mergeMutation.isPending || !aliasInput.trim()} onClick={submitAlias}>
                  {t('models.aliasMergeAdd')}
                </Button>
              </div>
              {groupAliases.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {groupAliases.map(alias => (
                    <div key={alias} className="flex items-center gap-2 text-xs">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{alias}</code>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={mergeMutation.isPending}
                        onClick={() => mergeMutation.mutate(removeAlias(merges, label, alias))}
                      >
                        {t('models.aliasMergeRemove')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Ready-to-run snippet that references this model by its unified id. */}
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <CopyButton text={snippet} className="size-7 shrink-0" label={t('common.copy')} />
                <span className="text-xs font-medium">{t('models.codeSnippetHeading')}</span>
              </div>
              <pre className="overflow-x-auto px-4 py-3 text-[11px] leading-relaxed"><code className="font-mono">{snippet}</code></pre>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ProviderSettingsRow({
  model,
  endpointLabel,
  endpointTitle,
  saving,
  deleting,
  onSave,
  onDelete,
  splitAction,
}: {
  model: Row
  // Which provider this card is for. Carries the endpoint too, but only when
  // two custom endpoints serve the same model id (#651).
  endpointLabel: string
  // Hover text for that label, set only when there was a collision to resolve.
  endpointTitle?: string
  saving: boolean
  deleting: boolean
  onSave: (patch: ModelSettingsPatch) => void
  onDelete: () => void
  splitAction?: SplitAction
}) {
  const { t } = useI18n()
  // `members` is rebuilt on every render, so depend on the model's own values
  // rather than the object identity — otherwise the form resets mid-edit.
  const {
    modelDbId, displayName, contextWindow, intelligenceRank, speedRank, sizeLabel,
    rpmLimit, rpdLimit, tpmLimit, tpdLimit, supportsVision, supportsTools, enabled,
  } = model
  const source: ModelSettingsSource = useMemo(() => ({
    displayName, contextWindow, intelligenceRank, speedRank, sizeLabel,
    rpmLimit, rpdLimit, tpmLimit, tpdLimit, supportsVision, supportsTools, enabled,
  }), [displayName, contextWindow, intelligenceRank, speedRank, sizeLabel, rpmLimit, rpdLimit,
    tpmLimit, tpdLimit, supportsVision, supportsTools, enabled])

  const [form, setForm] = useState(() => modelSettingsForm(source))
  useEffect(() => setForm(modelSettingsForm(source)), [modelDbId, source])
  const setField = <K extends keyof typeof form>(key: K, value: typeof form[K]) =>
    setForm(current => ({ ...current, [key]: value }))

  const { patch, invalid, dirty } = reviewModelSettings(source, form)
  const canSave = dirty && patch !== null && !saving && !deleting
  const sourceLabel = model.source === 'custom' ? t('models.customModel') : t('models.catalogModel')
  // Fields whose effective value comes from a local override instead of the
  // catalog. Custom models are never catalog-managed, so this stays empty.
  const overridden = new Set(model.overrideFields ?? [])

  function save() {
    if (!canSave || !patch) return
    onSave(patch)
  }

  return (
    <div className="rounded-xl border bg-background/60 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium" title={endpointTitle}>{endpointLabel}</span>
        <code className="min-w-0 truncate rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">{model.modelId}</code>
        <CopyButton text={model.modelId} label={t('models.copyModelId')} className="size-6 shrink-0" />
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabel}</span>
        {model.hasOverrides && (
          <span className="rounded-full bg-emerald-600/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
            {t('models.localOverride')}
          </span>
        )}
        {splitAction?.kind === 'undo' && (
          <span className="rounded-full bg-amber-600/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            {t('models.splitBadge')}
          </span>
        )}
        {splitAction && (
          <Tooltip text={t(splitAction.kind === 'split' ? 'models.splitOutHint' : 'models.splitUndoHint')}>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              disabled={splitAction.pending}
              onClick={splitAction.onClick}
            >
              {splitAction.kind === 'split' ? <Split className="size-3" /> : <Merge className="size-3" />}
              {t(splitAction.kind === 'split' ? 'models.splitOut' : 'models.splitUndo')}
            </Button>
          </Tooltip>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_8rem_auto_auto_auto_auto] md:items-end">
        <label className="space-y-1 text-xs text-muted-foreground">
          <FieldLabel text={t('models.displayName')} overridden={overridden.has('displayName')} />
          <Input
            value={form.displayName}
            onChange={e => setField('displayName', e.target.value)}
            aria-invalid={invalid.displayName}
            className="text-sm"
          />
        </label>
        <NumberField
          label={t('models.contextWindow')}
          value={form.contextWindow}
          invalid={invalid.contextWindow}
          overridden={overridden.has('contextWindow')}
          onChange={value => setField('contextWindow', value)}
        />
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={form.supportsTools} onCheckedChange={value => setField('supportsTools', value)} />
          <FieldLabel text={t('models.tools')} overridden={overridden.has('supportsTools')} />
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={form.supportsVision} onCheckedChange={value => setField('supportsVision', value)} />
          <FieldLabel text={t('models.vision')} overridden={overridden.has('supportsVision')} />
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={form.fallbackEnabled} onCheckedChange={value => setField('fallbackEnabled', value)} />
          <span>{t('models.inFallback')}</span>
        </label>
        <div className="flex items-center justify-end gap-1">
          <Tooltip text={t('models.saveModelSettings')}>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!canSave} onClick={save}>
              <Save className="size-3.5" />
            </Button>
          </Tooltip>
          <ConfirmButton
            variant="destructive"
            size="icon-sm"
            armedSize="xs"
            armedClassName=""
            disabled={saving || deleting}
            onConfirm={onDelete}
            aria-label={t('common.delete')}
          >
            <Trash2 className="size-3.5" />
          </ConfirmButton>
        </div>
      </div>

      {/* Router inputs: the two ranks feed the scoring axes, the four limits
          feed rate-limit accounting. Editable because the catalog can be wrong
          for a given account, or silent about a brand-new model (#551). The
          capability tier sets the intelligence axis — a custom model without
          a recognized tier sits at the floor of it, so it gets a picker here
          (#685). */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-7">
        {/* Full-width on the 2/3-column layouts so the six number fields
            below still tile evenly; one row of seven on desktop. */}
        <label className="col-span-2 space-y-1 text-xs text-muted-foreground sm:col-span-3 md:col-span-1" title={t('models.sizeLabelHint')}>
          <FieldLabel text={t('models.sizeLabel')} overridden={overridden.has('sizeLabel')} />
          <Select value={form.sizeLabel} onValueChange={value => setField('sizeLabel', value ?? '')}>
            <SelectTrigger className="w-full" aria-label={t('models.sizeLabel')}>
              <SelectValue placeholder={t('models.sizeLabelNone')} />
            </SelectTrigger>
            <SelectContent>
              {SIZE_LABELS.map(label => (
                <SelectItem key={label} value={label}>{label}</SelectItem>
              ))}
              <SelectItem value="">{t('models.sizeLabelNone')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <NumberField
          label={t('models.intelligenceRank')}
          hint={t('models.rankHint')}
          min={RANK_MIN}
          max={RANK_MAX}
          value={form.intelligenceRank}
          invalid={invalid.intelligenceRank}
          overridden={overridden.has('intelligenceRank')}
          onChange={value => setField('intelligenceRank', value)}
        />
        <NumberField
          label={t('models.speedRank')}
          hint={t('models.rankHint')}
          min={RANK_MIN}
          max={RANK_MAX}
          value={form.speedRank}
          invalid={invalid.speedRank}
          overridden={overridden.has('speedRank')}
          onChange={value => setField('speedRank', value)}
        />
        <NumberField
          label={t('models.limitRpm')}
          hint={t('models.limitRpmHint')}
          value={form.rpmLimit}
          invalid={invalid.rpmLimit}
          overridden={overridden.has('rpmLimit')}
          onChange={value => setField('rpmLimit', value)}
        />
        <NumberField
          label={t('models.limitRpd')}
          hint={t('models.limitRpdHint')}
          value={form.rpdLimit}
          invalid={invalid.rpdLimit}
          overridden={overridden.has('rpdLimit')}
          onChange={value => setField('rpdLimit', value)}
        />
        <NumberField
          label={t('models.limitTpm')}
          hint={t('models.limitTpmHint')}
          value={form.tpmLimit}
          invalid={invalid.tpmLimit}
          overridden={overridden.has('tpmLimit')}
          onChange={value => setField('tpmLimit', value)}
        />
        <NumberField
          label={t('models.limitTpd')}
          hint={t('models.limitTpdHint')}
          value={form.tpdLimit}
          invalid={invalid.tpdLimit}
          overridden={overridden.has('tpdLimit')}
          onChange={value => setField('tpdLimit', value)}
        />
      </div>
    </div>
  )
}

// A field label that says whether the value below it is still the catalog's or
// has been replaced locally — the same emerald the row-level badge uses.
function FieldLabel({ text, overridden }: { text: string; overridden: boolean }) {
  const { t } = useI18n()
  return (
    <span className="flex items-center gap-1">
      {text}
      {overridden && (
        <span
          title={t('models.localOverride')}
          aria-label={t('models.localOverride')}
          className="size-1.5 shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-400"
        />
      )}
    </span>
  )
}

function NumberField({
  label,
  hint,
  value,
  invalid,
  overridden,
  onChange,
  min = 1,
  max,
}: {
  label: string
  hint?: string
  value: string
  invalid: boolean
  overridden: boolean
  onChange: (value: string) => void
  min?: number
  max?: number
}) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground" title={hint}>
      <FieldLabel text={label} overridden={overridden} />
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-invalid={invalid}
        className="text-sm tabular-nums"
      />
    </label>
  )
}
