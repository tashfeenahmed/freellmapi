import { useState, useRef, useEffect, useMemo, useCallback, memo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  AlignJustify,
  LayoutGrid,
  Kanban as KanbanIcon,
  ListOrdered,
  Filter,
  Zap,
  Hourglass,
  FileText,
  BookOpen,
  Pencil,
  Trash2,
  Archive,
  Plus,
  ToggleLeft,
  ToggleRight,
  Settings
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { ProfilesModal } from '@/components/profiles-modal'
import { CreateProfileModal } from '@/components/create-profile-modal'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  tpmLimit: number | null
  tpdLimit: number | null
  monthlyTokenBudget: string
  keyCount: number
}

interface Profile {
  id: number
  name: string
  emoji: string
  color: string
  type: string
  is_favorite: number
  sort_order: number
  auto_sort?: 'intelligence' | 'speed' | 'budget' | null
  layout_config?: string | null
}

interface BlockConfig {
  id: string
  name: string
}

interface LayoutConfig {
  blocks: BlockConfig[]
  modelBlocks: Record<number, string> // modelDbId -> blockId
  archivedModels: number[] // modelDbId[]
  viewMode?: 'list' | 'grid' | 'kanban' | 'tier'
  compactMode?: boolean
  limitsMode?: 'off' | 'hover' | 'always'
  limitsVariant?: 'c' | 'a' | 'b'
  autoMoveDisabled?: boolean
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) {
    const val = n / 1_000_000_000
    return `${val % 1 === 0 ? val : val.toFixed(1)}B`
  }
  if (n >= 1_000_000) {
    const val = n / 1_000_000
    return `${val % 1 === 0 ? val : val.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const val = n / 1_000
    return `${val % 1 === 0 ? val : val.toFixed(1)}K`
  }
  return String(n)
}

function renderLimitsInline(m: any): React.ReactNode {
  const minParts: React.ReactNode[] = []
  if (m.rpmLimit != null) {
    minParts.push(
      <span key="rpm" className="inline-flex items-center">
        <Zap className="size-3 text-muted-foreground/60" />
        <span>{formatTokens(m.rpmLimit)}</span>
      </span>
    )
  }
  if (m.tpmLimit != null) {
    minParts.push(
      <span key="tpm" className="inline-flex items-center">
        <FileText className="size-3 text-muted-foreground/60" />
        <span>{formatTokens(m.tpmLimit)}</span>
      </span>
    )
  }

  const dayParts: React.ReactNode[] = []
  if (m.rpdLimit != null) {
    dayParts.push(
      <span key="rpd" className="inline-flex items-center">
        <Hourglass className="size-3 text-muted-foreground/60" />
        <span>{formatTokens(m.rpdLimit)}</span>
      </span>
    )
  }
  if (m.tpdLimit != null) {
    dayParts.push(
      <span key="tpd" className="inline-flex items-center">
        <BookOpen className="size-3 text-muted-foreground/60" />
        <span>{formatTokens(m.tpdLimit)}</span>
      </span>
    )
  }

  if (minParts.length === 0 && dayParts.length === 0) return null

  const elements: React.ReactNode[] = []

  if (minParts.length > 0) {
    elements.push(
      <div key="min" className="flex items-center">
        {minParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60">•</span>, item]), [])}
      </div>
    )
  }

  if (minParts.length > 0 && dayParts.length > 0) {
    elements.push(
      <span key="divider" className="opacity-60">|</span>
    )
  }

  if (dayParts.length > 0) {
    elements.push(
      <div key="day" className="flex items-center">
        {dayParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60">•</span>, item]), [])}
      </div>
    )
  }

  return (
    <div className="flex items-center select-none text-[9px] font-mono text-muted-foreground/60 leading-none">
      {elements}
    </div>
  )
}

function renderLimitsForCards(m: any): React.ReactNode {
  const minParts: React.ReactNode[] = []
  if (m.rpmLimit != null) {
    minParts.push(<span key="rpm">{formatTokens(m.rpmLimit)} rpm</span>)
  }
  if (m.tpmLimit != null) {
    minParts.push(<span key="tpm">{formatTokens(m.tpmLimit)} tpm</span>)
  }

  const dayParts: React.ReactNode[] = []
  if (m.rpdLimit != null) {
    dayParts.push(<span key="rpd">{formatTokens(m.rpdLimit)} rpd</span>)
  }
  if (m.tpdLimit != null) {
    dayParts.push(<span key="tpd">{formatTokens(m.tpdLimit)} tpd</span>)
  }

  if (minParts.length === 0 && dayParts.length === 0) return null

  const elements: React.ReactNode[] = []

  if (minParts.length > 0) {
    elements.push(
      <span key="min" className="inline-flex items-center gap-1">
        {minParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none mx-0.5">•</span>, item]), [])}
      </span>
    )
  }

  if (minParts.length > 0 && dayParts.length > 0) {
    elements.push(
      <span key="divider" className="opacity-60 select-none mx-1">|</span>
    )
  }

  if (dayParts.length > 0) {
    elements.push(
      <span key="day" className="inline-flex items-center gap-1">
        {dayParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none mx-0.5">•</span>, item]), [])}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center select-none font-mono leading-none gap-0.5">
      {elements}
    </span>
  )
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: {
    modelDbId: number
    displayName: string
    platform: string
    budget: number
    enabled: boolean
    rpmLimit?: number | null
    rpdLimit?: number | null
    tpmLimit?: number | null
    tpdLimit?: number | null
  }[]
}

const platformColors: Record<string, string> = {
  google: '#4285f4',
  groq: '#f55036',
  cerebras: '#8b5cf6',
  sambanova: '#14b8a6',
  nvidia: '#76b900',
  mistral: '#f59e0b',
  openrouter: '#ec4899',
  github: '#6e7b8b',
  cohere: '#d946ef',
  cloudflare: '#f38020',
  zhipu: '#06b6d4',
  ollama: '#000000',
  kilo: '#7c3aed',
  pollinations: '#a855f7',
  llm7: '#0ea5e9',
  huggingface: '#ff9d00',
}

function sortEntriesByPreset(entries: FallbackEntry[], preset: 'intelligence' | 'speed' | 'budget'): FallbackEntry[] {
  const sorted = [...entries]
  if (preset === 'intelligence') {
    sorted.sort((a, b) => a.intelligenceRank - b.intelligenceRank)
  } else if (preset === 'speed') {
    sorted.sort((a, b) => a.speedRank - b.speedRank)
  } else if (preset === 'budget') {
    const getBudgetScore = (e: FallbackEntry) => {
      if (e.tpdLimit != null) return e.tpdLimit * 30;
      
      const str = e.monthlyTokenBudget;
      if (!str) return 0;
      if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
      
      const cleanStr = str.split('(')[0];
      const matches = cleanStr.match(/[\d.]+/g);
      let maxNum = 0;
      if (matches) {
        maxNum = Math.max(...matches.map(m => parseFloat(m)));
      }
      
      let mult = 1;
      const upper = cleanStr.toUpperCase();
      if (upper.includes('B')) mult = 1_000_000_000;
      else if (upper.includes('M')) mult = 1_000_000;
      else if (upper.includes('K')) mult = 1_000;

      return maxNum * mult;
    };
    sorted.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
  }
  return sorted.map((e, index) => ({
    ...e,
    priority: index + 1,
  }))
}

/**
 * Recalculates model priorities (fallback indices) based on their layout blocks.
 * Models in earlier blocks receive higher priority (lower fallback index).
 * Inactive and archived models are pushed to the end.
 */
function recomputePrioritiesByBlocks(
  entries: FallbackEntry[],
  layout: LayoutConfig
): FallbackEntry[] {
  const archivedIds = layout.archivedModels || [];
  const active = entries.filter(e => e.keyCount > 0 && !archivedIds.includes(e.modelDbId));
  const inactive = entries.filter(e => e.keyCount === 0 || archivedIds.includes(e.modelDbId));

  if (layout.viewMode === 'list' || layout.viewMode === 'grid') {
    return [
      ...active.map((e, i) => ({ ...e, priority: i + 1 })),
      ...inactive.map((e, i) => ({ ...e, priority: active.length + i + 1 }))
    ];
  }

  // Collect active entries in block order, preserving within-block relative order
  const blockOrdered: FallbackEntry[] = [];
  for (const block of layout.blocks) {
    const blockModels = active.filter(e => {
      const explicit = layout.modelBlocks[e.modelDbId];
      const validBlockId = explicit && layout.blocks.some(b => b.id === explicit) ? explicit : layout.blocks[0]?.id;
      return validBlockId === block.id;
    });
    blockOrdered.push(...blockModels);
  }

  // Also collect any stragglers just in case (e.g. if layout.blocks is empty)
  const missing = active.filter(e => !blockOrdered.includes(e));

  return [
    ...blockOrdered.map((e, i) => ({ ...e, priority: i + 1 })),
    ...missing.map((e, i) => ({ ...e, priority: blockOrdered.length + i + 1 })),
    ...inactive.map((e, i) => ({ ...e, priority: blockOrdered.length + missing.length + i + 1 }))
  ];
}

type LimitsVariant = 'a' | 'b' | 'c'

function LimitsDisplay({ m, variant }: { m: { rpmLimit?: number | null; rpdLimit?: number | null; tpmLimit?: number | null; tpdLimit?: number | null }; variant: LimitsVariant }) {
  const hasLimits = m.rpmLimit != null || m.rpdLimit != null || m.tpmLimit != null || m.tpdLimit != null
  if (!hasLimits) return null

  if (variant === 'a') {
    // Variant A: compact single-line pill design
    const minParts: React.ReactNode[] = []
    if (m.rpmLimit != null) {
      minParts.push(
        <span key="rpm" className="inline-flex items-center gap-0.5">
          <Zap className="size-3 text-muted-foreground/60" />{formatTokens(m.rpmLimit)}/m
        </span>
      )
    }
    if (m.tpmLimit != null) {
      minParts.push(
        <span key="tpm" className="inline-flex items-center gap-0.5">
          <FileText className="size-3 text-muted-foreground/60" />{formatTokens(m.tpmLimit)}/m
        </span>
      )
    }

    const dayParts: React.ReactNode[] = []
    if (m.rpdLimit != null) {
      dayParts.push(
        <span key="rpd" className="inline-flex items-center gap-0.5">
          <Hourglass className="size-3 text-muted-foreground/60" />{formatTokens(m.rpdLimit)}/d
        </span>
      )
    }
    if (m.tpdLimit != null) {
      dayParts.push(
        <span key="tpd" className="inline-flex items-center gap-0.5">
          <BookOpen className="size-3 text-muted-foreground/60" />{formatTokens(m.tpdLimit)}/d
        </span>
      )
    }

    const elements: React.ReactNode[] = []
    if (minParts.length > 0) {
      elements.push(
        <Fragment key="min">
          {minParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none">•</span>, item]), [])}
        </Fragment>
      )
    }
    if (minParts.length > 0 && dayParts.length > 0) {
      elements.push(
        <span key="divider" className="opacity-60 select-none">|</span>
      )
    }
    if (dayParts.length > 0) {
      elements.push(
        <Fragment key="day">
          {dayParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none">•</span>, item]), [])}
        </Fragment>
      )
    }

    return (
      <div className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0 px-2 py-0.5 mt-0.5 rounded-full bg-muted/70 border border-border/50 text-[9px] font-mono text-muted-foreground w-fit whitespace-nowrap">
        {elements}
      </div>
    )
  }

  if (variant === 'b') {
    // Variant B: single-line with names, no emojis under the model name
    const minParts: React.ReactNode[] = []
    if (m.rpmLimit != null) minParts.push(<span key="rpm">rpm: {formatTokens(m.rpmLimit)}</span>)
    if (m.tpmLimit != null) minParts.push(<span key="tpm">tpm: {formatTokens(m.tpmLimit)}</span>)

    const dayParts: React.ReactNode[] = []
    if (m.rpdLimit != null) dayParts.push(<span key="rpd">rpd: {formatTokens(m.rpdLimit)}</span>)
    if (m.tpdLimit != null) dayParts.push(<span key="tpd">tpd: {formatTokens(m.tpdLimit)}</span>)

    const elements: React.ReactNode[] = []
    if (minParts.length > 0) {
      elements.push(
        <Fragment key="min">
          {minParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none">•</span>, item]), [])}
        </Fragment>
      )
    }
    if (minParts.length > 0 && dayParts.length > 0) {
      elements.push(
        <span key="divider" className="opacity-60 select-none">|</span>
      )
    }
    if (dayParts.length > 0) {
      elements.push(
        <Fragment key="day">
          {dayParts.reduce<React.ReactNode[]>((acc, item, idx) => (idx === 0 ? [item] : [...acc, <span key={`dot-${idx}`} className="opacity-60 select-none">•</span>, item]), [])}
        </Fragment>
      )
    }

    return (
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0 text-[9px] font-mono text-muted-foreground/60 mt-0.5 select-none leading-none">
        {elements}
      </div>
    )
  }

  if (variant === 'c') {
    return renderLimitsInline(m)
  }
}

function TokenUsageBar({
  data,
  autoMoveDisabled,
  displayEntries,
  limitsMode,
  setLimitsMode,
  limitsVariant,
  setLimitsVariant
}: {
  data: TokenUsageData;
  autoMoveDisabled: boolean;
  displayEntries: FallbackEntry[];
  limitsMode: 'off' | 'hover' | 'always';
  setLimitsMode: (v: 'off' | 'hover' | 'always') => void;
  limitsVariant: 'c' | 'a' | 'b';
  setLimitsVariant: (v: 'c' | 'a' | 'b') => void;
}) {
  const { totalBudget, totalUsed, models } = data
  const [legendMode, setLegendMode] = useState<'columns' | 'grid'>('columns')
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  const enabledMap = new Map(displayEntries.map(e => [e.modelDbId, e.enabled]))
  const orderMap = new Map(displayEntries.map((e, i) => [e.modelDbId, i]))

  const sortedModels = [...models]
    .map(m => ({
      ...m,
      enabled: enabledMap.has(m.modelDbId) ? enabledMap.get(m.modelDbId)! : m.enabled
    }))
    .sort((a, b) => {
      const orderA = orderMap.has(a.modelDbId) ? orderMap.get(a.modelDbId)! : 999
      const orderB = orderMap.has(b.modelDbId) ? orderMap.get(b.modelDbId)! : 999
      return orderA - orderB
    })

  const displayIds = new Set(displayEntries.map(e => e.modelDbId))
  const activeSortedModels = sortedModels.filter(m => displayIds.has(m.modelDbId))

  const modelsWithWidth = activeSortedModels.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  const displayModels = autoMoveDisabled
    ? [...modelsWithWidth].sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1))
    : modelsWithWidth

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Monthly token budget</h2>
          <select
            value={legendMode}
            onChange={e => setLegendMode(e.target.value as any)}
            className="text-[10px] bg-transparent text-muted-foreground outline-none cursor-pointer border rounded px-1 opacity-40 hover:opacity-100 transition-opacity"
            title="Legend layout"
          >
            <option value="columns">Cols</option>
            <option value="grid">Grid</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
            {/* Limits Mode Segmented Control */}
            <div className="flex items-center gap-0.5 bg-muted p-0.5 rounded-lg border">
              {[
                { id: 'off', label: 'Hide' },
                { id: 'hover', label: 'On Hover' },
                { id: 'always', label: 'Always' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setLimitsMode(opt.id as 'off' | 'hover' | 'always')}
                  className={`text-[10px] px-2 py-0.5 rounded-md font-medium transition-all ${limitsMode === opt.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Limits Variant Segmented Control */}
            {limitsMode === 'always' && (
              <div className="flex items-center gap-0.5 bg-muted p-0.5 rounded-lg border animate-in fade-in zoom-in-95 duration-150">
                {[
                  { id: 'c', label: 'Text' },
                  { id: 'a', label: 'Tags' },
                  { id: 'b', label: 'Detailed' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setLimitsVariant(opt.id as 'c' | 'a' | 'b')}
                    className={`text-[10px] px-2 py-0.5 rounded-md font-medium transition-all ${limitsVariant === opt.id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                      }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            <Tooltip>
              <TooltipTrigger
                delay={0}
                render={
                  <span className="text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors cursor-help p-1 rounded hover:bg-muted/50 shrink-0">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4" />
                      <path d="M12 8h.01" />
                    </svg>
                  </span>
                }
              />
              <TooltipContent side="bottom" className="max-w-[240px] text-left text-[10px] text-muted-foreground bg-popover px-2.5 py-2 leading-relaxed shadow-md border rounded-lg">
                <div className="font-semibold text-foreground mb-1">Limits Legend:</div>
                <ul className="space-y-1.5 list-none pl-0">
                  <li className="flex items-center gap-1.5">
                    <Zap className="size-3 text-muted-foreground/60 shrink-0" />
                    <span><strong className="text-foreground">rpm</strong> — requests per minute</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <FileText className="size-3 text-muted-foreground/60 shrink-0" />
                    <span><strong className="text-foreground">tpm</strong> — tokens per minute</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Hourglass className="size-3 text-muted-foreground/60 shrink-0" />
                    <span><strong className="text-foreground">rpd</strong> — requests per day</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <BookOpen className="size-3 text-muted-foreground/60 shrink-0" />
                    <span><strong className="text-foreground">tpd</strong> — tokens per day</span>
                  </li>
                </ul>
              </TooltipContent>
            </Tooltip>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
            <span className="text-foreground font-medium">{formatTokens(remaining)}</span> remaining
            <span className="mx-1.5">·</span>
            {remainingPct}% of {formatTokens(totalBudget)}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}) — ${formatTokens(m.remainingTokens)} remaining${m.enabled ? '' : '  — disabled'}`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: m.enabled
                ? (platformColors[m.platform] ?? '#94a3b8')
                : `${platformColors[m.platform] ?? '#94a3b8'}22`, // ~13% opacity solid flat color
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used — ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      {/* Legend */}
      <div className={`mt-4 text-xs tabular-nums ${legendMode === 'columns'
        ? 'columns-1 sm:columns-2 lg:columns-3 gap-x-6'
        : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-0'
        }`}>
        {displayModels.map((m, i) => {
          const hasLimits = m.rpmLimit != null || m.rpdLimit != null || m.tpmLimit != null || m.tpdLimit != null;
          return (
            <div
              key={i}
              className={`flex flex-col gap-0 min-w-0 py-1.5 transition-opacity break-inside-avoid group ${m.enabled ? 'opacity-100' : 'opacity-40'
                }`}
            >
              <div className="flex items-center justify-between gap-3 min-w-0 w-full">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span
                    className="size-2 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: m.enabled ? (platformColors[m.platform] ?? '#94a3b8') : '#94a3b8' }}
                  />
                  <span className="truncate font-medium" title={m.displayName}>{m.displayName}</span>
                  {!m.enabled && (
                    <span className="text-muted-foreground text-[10px] shrink-0">(off)</span>
                  )}
                  {limitsMode === 'hover' && hasLimits && (
                    <Tooltip>
                      <TooltipTrigger
                        delay={0}
                        render={
                          <span className="cursor-help text-muted-foreground/35 hover:text-muted-foreground/70 transition-colors shrink-0 ml-1">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <circle cx="12" cy="12" r="10" />
                              <path d="M12 16v-4" />
                              <path d="M12 8h.01" />
                            </svg>
                          </span>
                        }
                      />
                      <TooltipContent side="bottom" className="max-w-[240px] text-left text-[10px] text-muted-foreground bg-popover px-2.5 py-2 leading-relaxed shadow-md border rounded-lg">
                        <div className="font-semibold text-foreground mb-1">Model Limits:</div>
                        <ul className="space-y-1.5 list-none pl-0">
                          {m.rpmLimit != null && (
                            <li className="flex items-center gap-1.5">
                              <Zap className="size-3 text-muted-foreground/60 shrink-0" />
                              <span><strong className="text-foreground">rpm</strong> — {formatTokens(m.rpmLimit)} req/min</span>
                            </li>
                          )}
                          {m.tpmLimit != null && (
                            <li className="flex items-center gap-1.5">
                              <FileText className="size-3 text-muted-foreground/60 shrink-0" />
                              <span><strong className="text-foreground">tpm</strong> — {formatTokens(m.tpmLimit)} tok/min</span>
                            </li>
                          )}
                          {m.rpdLimit != null && (
                            <li className="flex items-center gap-1.5">
                              <Hourglass className="size-3 text-muted-foreground/60 shrink-0" />
                              <span><strong className="text-foreground">rpd</strong> — {formatTokens(m.rpdLimit)} req/day</span>
                            </li>
                          )}
                          {m.tpdLimit != null && (
                            <li className="flex items-center gap-1.5">
                              <BookOpen className="size-3 text-muted-foreground/60 shrink-0" />
                              <span><strong className="text-foreground">tpd</strong> — {formatTokens(m.tpdLimit)} tok/day</span>
                            </li>
                          )}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {limitsMode === 'always' && limitsVariant === 'c' && hasLimits && (
                    <div className="shrink-0">
                      {renderLimitsInline(m)}
                    </div>
                  )}
                  <span className="font-mono text-muted-foreground text-[11px] shrink-0 min-w-[32px] text-right">
                    {formatTokens(m.remainingTokens)}
                  </span>
                </div>
              </div>
              {limitsMode === 'always' && limitsVariant !== 'c' && (
                <LimitsDisplay m={m} variant={limitsVariant} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  )
}

const handleDragPointerDown = (e: React.PointerEvent) => {
  if (e.button !== 0) return; // Only left click

  document.body.classList.add('is-dragging-dnd');

  const cleanUp = () => {
    document.body.classList.remove('is-dragging-dnd');
    window.removeEventListener('pointerup', cleanUp);
    window.removeEventListener('pointercancel', cleanUp);
  };

  window.addEventListener('pointerup', cleanUp);
  window.addEventListener('pointercancel', cleanUp);
};

const SortableModelRow = memo(function SortableModelRow({
  entry,
  index,
  isDndDisabled,
  onToggle,
  onArchive,
  className,
}: {
  entry: FallbackEntry
  index: number
  isDndDisabled: boolean
  onToggle: (modelDbId: number, enabled: boolean) => void
  onArchive?: (modelDbId: number, e: React.MouseEvent) => void
  className?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
    disabled: isDndDisabled,
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition: isDragging ? undefined : transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50 z-10 shadow-lg' : ''} ${entry.enabled ? '' : 'opacity-50'} ${className ?? ''}`}
    >
      {!isDndDisabled && (
        <button
          {...attributes}
          {...listeners}
          onPointerDown={(e) => {
            handleDragPointerDown(e);
            if (listeners?.onPointerDown) listeners.onPointerDown(e);
          }}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors p-2.5 -m-2 rounded-md hover:bg-muted/50 shrink-0"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
          </svg>
        </button>
      )}
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-muted/50 border shrink-0">
            <span className="size-2 rounded-full" style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }} />
            <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{entry.platform}</span>
          </div>
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
        </div>
        <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground tabular-nums items-center">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {renderLimitsForCards(entry)}
          <span>{entry.monthlyTokenBudget}</span>
        </div>
      </div>
      {onArchive && (
        <button
          onClick={(e) => { e.stopPropagation(); onArchive(entry.modelDbId, e); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-muted-foreground hover:text-red-500 rounded hover:bg-muted/50 shrink-0"
          title="Archive model"
        >
          <Archive className="size-3.5" />
        </button>
      )}
      <Switch
        checked={entry.enabled}
        onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
      />
    </div>
  )
})

const SortableModelChip = memo(function SortableModelChip({
  entry,
  index,
  isDndDisabled,
  onToggle,
  onArchive,
  viewMode,
  compactMode,
}: {
  entry: FallbackEntry
  index: number
  isDndDisabled: boolean
  onToggle: (modelDbId: number, enabled: boolean) => void
  onArchive?: (modelDbId: number, e: React.MouseEvent) => void
  viewMode?: string
  compactMode?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
    disabled: isDndDisabled,
  })

  const isCompact = (viewMode === 'kanban' || viewMode === 'tier') && compactMode

  const style = {
    transform: CSS.Translate.toString(transform),
    transition: isDragging ? undefined : transition,
    ...(isDragging ? { zIndex: 50 } : { zIndex: 1 })
  }

  if (isCompact) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`group flex items-stretch justify-between bg-card border rounded-lg transition-colors relative select-none min-h-[34px] ${isDragging ? 'opacity-50 shadow-md scale-[1.02] z-50' : 'relative'
          } ${entry.enabled ? 'border-foreground/10 hover:border-foreground/30 shadow-sm hover:shadow' : 'opacity-40 border-border bg-muted/30'}`}
      >
        {/* Zone 1: Drag handle + Sequence number with provider color */}
        <div
          {...attributes}
          {...listeners}
          onPointerDown={(e) => {
            handleDragPointerDown(e);
            if (listeners?.onPointerDown) listeners.onPointerDown(e);
          }}
          className="w-10 shrink-0 flex items-center justify-center gap-1 border-r border-border/40 hover:bg-muted/40 transition-colors cursor-grab active:cursor-grabbing self-stretch pl-1 pr-1.5"
          title="Drag model"
        >
          <svg width="8" height="12" viewBox="0 0 12 24" fill="currentColor" className="text-muted-foreground/35 group-hover:text-muted-foreground/70 transition-colors shrink-0">
            <circle cx="3" cy="6" r="2" /><circle cx="9" cy="6" r="2" />
            <circle cx="3" cy="12" r="2" /><circle cx="9" cy="12" r="2" />
            <circle cx="3" cy="18" r="2" /><circle cx="9" cy="18" r="2" />
          </svg>
          <div
            className="w-5 h-5 rounded-full border border-white/20 dark:border-black/20 flex items-center justify-center text-[10px] font-bold text-white shrink-0 shadow-sm select-none"
            style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }}
          >
            <span className="leading-none text-center font-mono font-bold text-[10px] w-full">
              {index + 1}
            </span>
          </div>
        </div>

        {/* Zone 2: Model Name - wrapped in Tooltip for metrics detail */}
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <div className="flex-1 min-w-0 px-2 py-1 flex items-center hover:bg-muted/10 transition-colors cursor-help self-stretch">
                <div className="flex items-center gap-1.5 flex-wrap w-full">
                  <span className="font-semibold text-[11px] text-foreground break-words whitespace-normal leading-tight" title={entry.displayName}>
                    {entry.displayName}
                  </span>
                  {entry.penalty > 0 && (
                    <span className="text-[9px] text-amber-600 dark:text-amber-400 shrink-0 font-medium leading-none">
                      −{entry.penalty}
                    </span>
                  )}
                </div>
              </div>
            }
          />
          <TooltipContent
            side={viewMode === 'kanban' ? 'right' : 'top'}
            className="max-w-[280px] text-left bg-popover px-3 py-2.5 shadow-xl border rounded-xl animate-in fade-in-0 zoom-in-95 duration-100 pointer-events-none z-[100]"
          >
            <div className="font-semibold text-foreground text-sm flex items-center gap-1.5 mb-1.5">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{entry.displayName}</span>
            </div>
            <div className="text-[11px] text-muted-foreground space-y-1">
              <div className="flex justify-between gap-4">
                <span>Provider:</span>
                <span className="font-semibold text-foreground uppercase">{entry.platform}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Intelligence Rank:</span>
                <span className="font-semibold text-foreground">#{entry.intelligenceRank}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Speed Rank:</span>
                <span className="font-semibold text-foreground">#{entry.speedRank}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Monthly Token Budget:</span>
                <span className="font-semibold text-foreground">{entry.monthlyTokenBudget}</span>
              </div>
              {entry.penalty > 0 && (
                <div className="flex justify-between gap-4 text-amber-600 dark:text-amber-400">
                  <span>Penalty:</span>
                  <span className="font-semibold">−{entry.penalty}</span>
                </div>
              )}
            </div>

            {(entry.rpmLimit != null || entry.rpdLimit != null || entry.tpmLimit != null || entry.tpdLimit != null) && (
              <>
                <div className="border-t my-1.5 border-border/50" />
                <div className="text-[10px] font-semibold text-foreground mb-1">Limits:</div>
                <ul className="space-y-1 list-none pl-0 text-[10px] text-muted-foreground">
                  {entry.rpmLimit != null && (
                    <li className="flex items-center gap-1.5">
                      <Zap className="size-3 text-muted-foreground/60 shrink-0" />
                      <span><strong>rpm</strong> — {formatTokens(entry.rpmLimit)} req/min</span>
                    </li>
                  )}
                  {entry.tpmLimit != null && (
                    <li className="flex items-center gap-1.5">
                      <FileText className="size-3 text-muted-foreground/60 shrink-0" />
                      <span><strong>tpm</strong> — {formatTokens(entry.tpmLimit)} tok/min</span>
                    </li>
                  )}
                  {entry.rpdLimit != null && (
                    <li className="flex items-center gap-1.5">
                      <Hourglass className="size-3 text-muted-foreground/60 shrink-0" />
                      <span><strong>rpd</strong> — {formatTokens(entry.rpdLimit)} req/day</span>
                    </li>
                  )}
                  {entry.tpdLimit != null && (
                    <li className="flex items-center gap-1.5">
                      <BookOpen className="size-3 text-muted-foreground/60 shrink-0" />
                      <span><strong>tpd</strong> — {formatTokens(entry.tpdLimit)} tok/day</span>
                    </li>
                  )}
                </ul>
              </>
            )}
          </TooltipContent>
        </Tooltip>

        {/* Zone 3: Right Controls */}
        <div
          className="flex items-center gap-1 px-1.5 shrink-0 self-stretch justify-center"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Switch
            checked={entry.enabled}
            onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
            className="scale-[0.7] origin-right shrink-0"
          />
          {onArchive && (
            <button
              onClick={(e) => { e.stopPropagation(); onArchive(entry.modelDbId, e); }}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:text-red-500 hover:bg-muted rounded shrink-0"
              title="Archive model"
            >
              <Archive className="size-3" />
            </button>
          )}
        </div>
      </div>
    )
  }

  // Existing layout for non-compact (Grid mode)
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-stretch bg-card border rounded-lg transition-colors relative ${isDragging ? 'opacity-50 shadow-md scale-[1.02]' : 'relative'
        } ${entry.enabled ? 'border-foreground/10 hover:border-foreground/30 shadow-sm hover:shadow' : 'opacity-40 border-border bg-muted/30'}`}
    >
      {/* Drag handle */}
      {!isDndDisabled && (
        <button
          {...attributes}
          {...listeners}
          onPointerDown={(e) => {
            handleDragPointerDown(e);
            if (listeners?.onPointerDown) listeners.onPointerDown(e);
          }}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors w-7 flex items-center justify-center shrink-0 border-r border-border/40 rounded-l-lg"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="12" height="18" viewBox="0 0 12 24" fill="currentColor">
            <circle cx="3" cy="6" r="1.8" /><circle cx="9" cy="6" r="1.8" />
            <circle cx="3" cy="12" r="1.8" /><circle cx="9" cy="12" r="1.8" />
            <circle cx="3" cy="18" r="1.8" /><circle cx="9" cy="18" r="1.8" />
          </svg>
        </button>
      )}

      {/* Number centered vertically */}
      <div className="flex items-center justify-center pl-2 shrink-0 select-none">
        <span className="text-[10px] font-mono text-muted-foreground w-4 shrink-0 tabular-nums text-center">
          {index + 1}
        </span>
      </div>

      {/* Content wrapper */}
      <div className="flex-1 min-w-0 pr-2 py-1.5 flex flex-col justify-center gap-0.5 pl-1.5">
        {/* Row 1: Name, Switch + Archive */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <div className="flex-1 min-w-0 flex flex-col gap-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-[11px] text-foreground break-words whitespace-normal leading-none py-0.5" title={entry.displayName}>
                {entry.displayName}
              </span>
              {entry.penalty > 0 && (
                <span className="text-[9px] text-amber-600 dark:text-amber-400 shrink-0 font-medium leading-none">
                  −{entry.penalty}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 px-1 mt-0.5 bg-muted/60 border rounded text-[7px] font-extrabold uppercase tracking-wider text-muted-foreground w-fit leading-none py-0.5">
              <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }} />
              <span className="truncate">{entry.platform}</span>
            </div>
          </div>

          {/* Right Controls stacked vertically */}
          <div className="flex flex-col items-center gap-1 shrink-0 ml-1.5">
            <Switch
              checked={entry.enabled}
              onCheckedChange={(checked) => onToggle(entry.modelDbId, checked)}
              className="scale-75 origin-right shrink-0"
            />
            {onArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); onArchive(entry.modelDbId, e); }}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-red-500 hover:bg-muted rounded shrink-0"
                title="Archive model"
              >
                <Archive className="size-3" />
              </button>
            )}
          </div>
        </div>
        {/* Row 2: Stats */}
        <div className="flex items-center gap-1 text-[8px] text-muted-foreground/80 flex-wrap pl-0.5 tabular-nums leading-none mt-0.5">
          <span>Intel #{entry.intelligenceRank}</span>
          <span className="text-muted-foreground/30">•</span>
          <span>Speed #{entry.speedRank}</span>
          <span className="text-muted-foreground/30">•</span>
          <span>{entry.monthlyTokenBudget}</span>
          {(entry.rpmLimit != null || entry.tpmLimit != null || entry.rpdLimit != null || entry.tpdLimit != null) && (
            <>
              <span className="text-muted-foreground/30">•</span>
              {renderLimitsForCards(entry)}
            </>
          )}
        </div>
      </div>
    </div>
  )
})

function InlineEdit({
  value,
  onSave,
  maxLength = 20,
  className = "max-w-[120px]",
  wrapText = false
}: {
  value: string,
  onSave: (v: string) => void,
  maxLength?: number,
  className?: string,
  wrapText?: boolean
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`h-6 w-full px-1 text-sm bg-background border rounded font-medium ${className}`}
        value={val}
        maxLength={maxLength}
        onChange={e => setVal(e.target.value)}
        onBlur={() => { setEditing(false); onSave(val); }}
        onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onSave(val); } }}
      />
    )
  }
  return (
    <div className="relative flex items-center justify-between w-full flex-1 min-w-0 group/edit cursor-pointer border-b border-dashed border-muted-foreground/15 hover:border-muted-foreground/45 pb-0.5" onDoubleClick={() => setEditing(true)}>
      <span className={`font-semibold text-sm uppercase tracking-wider text-muted-foreground block flex-1 min-w-[50px] min-h-[1.25rem] ${wrapText ? 'whitespace-normal break-words' : 'truncate mr-1'} ${className}`} title={value || "Name block"}>
        {value || ' '}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        className={`opacity-0 group-hover/edit:opacity-100 text-muted-foreground hover:text-foreground transition-opacity shrink-0 ${wrapText
          ? 'absolute right-0 top-1/2 -translate-y-1/2 bg-background/90 dark:bg-background/90 rounded border p-0.5 shadow-sm z-10'
          : 'p-0.5'
          }`}
      >
        <Pencil className="size-3" />
      </button>
    </div>
  )
}

function BlockContainer({
  block,
  items,
  viewMode,
  onRename,
  onDelete,
  onToggleAll,
  canDelete,
  isBlockActive,
  children
}: {
  block: BlockConfig,
  items: number[],
  viewMode: 'kanban' | 'tier',
  onRename: (id: string, name: string) => void,
  onDelete: (id: string) => void,
  onToggleAll: (id: string, enabled: boolean) => void,
  canDelete: boolean,
  isBlockActive?: boolean,
  children: React.ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: block.id });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setConfirmDelete(false);
      }
    }
    if (confirmDelete) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [confirmDelete]);

  if (viewMode === 'tier') {
    return (
      <div ref={setNodeRef} style={isBlockActive ? { zIndex: 40, position: 'relative' } : undefined} className="flex flex-col sm:flex-row gap-2 p-2 bg-card border rounded-lg shadow-sm relative group/block items-stretch">
        <div ref={headerRef} className="sm:w-28 shrink-0 flex flex-col items-center justify-start rounded-md border bg-muted/10 p-2 overflow-hidden self-stretch min-h-[72px] gap-2">
          {confirmDelete ? (
            <div className="flex flex-col items-center justify-center text-center w-full px-1 py-1 my-auto animate-in fade-in zoom-in-95 duration-150">
              <span className="text-[10px] font-semibold text-destructive leading-tight">Delete block?</span>
              <div className="flex items-center gap-1 mt-1.5 w-full">
                <button
                  onClick={() => { onDelete(block.id); setConfirmDelete(false); }}
                  className="flex-1 px-1.5 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[9px] font-semibold transition-colors"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="flex-1 px-1.5 py-0.5 bg-muted text-muted-foreground rounded text-[9px] font-semibold hover:bg-muted/80 transition-colors"
                >
                  No
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Top: Name */}
              <div className="w-full flex justify-center">
                <InlineEdit value={block.name} onSave={(v) => onRename(block.id, v)} maxLength={12} className="max-w-[140px] sm:max-w-[80px] w-full text-center" wrapText={true} />
              </div>

              {/* Middle: Count */}
              <span className="text-[9px] font-medium opacity-60 select-none shrink-0">{items.length} models</span>

              {/* Bottom: Controls */}
              <div className="flex items-center gap-1 shrink-0">
                <div className="inline-flex items-center rounded border bg-background overflow-hidden scale-90">
                  <button
                    onClick={() => onToggleAll(block.id, false)}
                    className="p-1 hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors border-r"
                    title="Disable all"
                  >
                    <ToggleLeft className="size-3.5" />
                  </button>
                  <button
                    onClick={() => onToggleAll(block.id, true)}
                    className="p-1 hover:bg-muted text-muted-foreground hover:text-emerald-600 transition-colors"
                    title="Enable all"
                  >
                    <ToggleRight className="size-3.5" />
                  </button>
                </div>
                {canDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="p-1 hover:bg-muted text-muted-foreground hover:text-destructive rounded transition-colors shrink-0"
                    title="Delete block"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="flex-1">
          <SortableContext items={items} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap gap-1.5 content-start min-h-[60px] w-full">
              {children}
            </div>
          </SortableContext>
        </div>
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={isBlockActive ? { zIndex: 40, position: 'relative' } : undefined} className="min-w-[270px] w-full sm:w-[270px] flex-shrink-0 bg-muted/10 rounded-lg p-2 border snap-start flex flex-col h-full group/block">
      <div ref={headerRef} className="flex items-center gap-2 mb-2 px-1 justify-between min-h-[28px]">
        {confirmDelete ? (
          <div className="flex items-center justify-between w-full text-xs py-0.5 animate-in fade-in zoom-in-95 duration-150">
            <span className="font-semibold text-destructive">Delete block?</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => { onDelete(block.id); setConfirmDelete(false); }}
                className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-semibold transition-colors"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-0.5 bg-muted text-muted-foreground rounded text-[10px] font-semibold hover:bg-muted/80 transition-colors"
              >
                No
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
              <span className="text-[10px] font-mono text-muted-foreground bg-background px-1.5 py-0.5 rounded border shrink-0">{items.length}</span>
              <InlineEdit value={block.name} onSave={(v) => onRename(block.id, v)} maxLength={11} className="max-w-[140px] w-full" />
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover/block:opacity-100 transition-opacity shrink-0">
              <div className="inline-flex items-center rounded border bg-background overflow-hidden scale-90">
                <button
                  onClick={() => onToggleAll(block.id, false)}
                  className="p-1 hover:bg-muted text-muted-foreground hover:text-red-500 transition-colors border-r"
                  title="Disable all"
                >
                  <ToggleLeft className="size-3.5" />
                </button>
                <button
                  onClick={() => onToggleAll(block.id, true)}
                  className="p-1 hover:bg-muted text-muted-foreground hover:text-emerald-600 transition-colors"
                  title="Enable all"
                >
                  <ToggleRight className="size-3.5" />
                </button>
              </div>
              {canDelete && (
                <button onClick={() => setConfirmDelete(true)} className="p-0.5 text-muted-foreground hover:text-destructive rounded transition-colors" title="Delete block">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5 min-h-[60px] h-full">
          {children}
        </div>
      </SortableContext>
    </div>
  )
}

export default function FallbackPage() {
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [localLayout, setLocalLayout] = useState<LayoutConfig | null>(null)
  const [activeProfile, setActiveProfile] = useState<number | null>(null)
  const [isInitialized, setIsInitialized] = useState(false)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [animatingArchives, setAnimatingArchives] = useState<{ id: number; name: string; platform: string; startX: number; startY: number; width: number; height: number; key: number; stage: 'start' | 'end'; targetX: number; targetY: number }[]>([])
  const [showArchiveIndicator, setShowArchiveIndicator] = useState(false)
  const archiveIndicatorTimeoutRef = useRef<any>(null)
  const [globalIsDragging, setGlobalIsDragging] = useState(false)
  const [activeId, setActiveId] = useState<number | string | null>(null)
  const lastCrossBlockMoveTimeRef = useRef(0)
  const dragStartEntriesRef = useRef<FallbackEntry[] | null>(null)


  const [activeProviderFilters, setActiveProviderFilters] = useState<string[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const filterPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (filterPopoverRef.current && !filterPopoverRef.current.contains(event.target as Node)) {
        setFilterOpen(false)
      }
    }
    if (filterOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [filterOpen])
  const [profilesModalOpen, setProfilesModalOpen] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [localProfiles, setLocalProfiles] = useState<Profile[] | null>(null)
  const [profilesExpanded, setProfilesExpanded] = useState(false)
  const baselineRef = useRef<string>('')
  const crossBlockMoveRef = useRef(false)

  const { data: globalEntries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
    placeholderData: keepPreviousData,
  })

  const { data: fetchedProfiles = [] } = useQuery<Profile[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })

  const profiles = localProfiles ?? fetchedProfiles
  const [hiddenCount, setHiddenCount] = useState(0)
  const profilesContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = profilesContainerRef.current
    if (!container) return

    const updateHiddenCount = () => {
      const children = Array.from(container.children) as HTMLElement[]
      if (children.length === 0) {
        setHiddenCount(0)
        return
      }

      const firstChild = children[0]
      const baselineOffset = firstChild.offsetTop

      let count = 0
      for (let i = 1; i < children.length; i++) {
        if (children[i].offsetTop > baselineOffset + 4) {
          count++
        }
      }
      setHiddenCount(count)
    }

    updateHiddenCount()

    const observer = new ResizeObserver(() => {
      updateHiddenCount()
    })
    observer.observe(container)
    window.addEventListener('resize', updateHiddenCount)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHiddenCount)
    }
  }, [profiles])

  const showBadge = hiddenCount > 0

  // 1. Fetch active profile ID from backend
  const { data: activeProfileData } = useQuery<{ activeProfileId: number | null }>({
    queryKey: ['profiles', 'active'],
    queryFn: () => apiFetch('/api/profiles/active'),
  })

  // 2. Query profile models if a profile is active
  const { data: profileModels, isPlaceholderData } = useQuery<any[]>({
    queryKey: ['profiles', activeProfile, 'models'],
    queryFn: () => apiFetch(`/api/profiles/${activeProfile}/models`),
    enabled: activeProfile !== null,
    placeholderData: keepPreviousData,
  })

  const prevActiveProfileRef = useRef<number | null>(activeProfile)
  useEffect(() => {
    if (!isPlaceholderData) {
      prevActiveProfileRef.current = activeProfile
    }
  }, [activeProfile, isPlaceholderData])

  const effectiveProfileId = isPlaceholderData ? prevActiveProfileRef.current : activeProfile

  // Compute active profile object
  const activeProfileObj = useMemo(() => {
    return profiles.find(p => p.id === effectiveProfileId) || null
  }, [profiles, effectiveProfileId])

  // Parse layout_config from the active profile
  const parsedLayout = useMemo<LayoutConfig>(() => {
    const defaultLayout: LayoutConfig = {
      viewMode: 'list',
      compactMode: false,
      limitsMode: 'off',
      limitsVariant: 'c',
      autoMoveDisabled: false,
      blocks: [{ id: 'default_block_id', name: 'Default' }],
      modelBlocks: {},
      archivedModels: []
    }

    if (!activeProfileObj || !activeProfileObj.layout_config) {
      return defaultLayout
    }

    try {
      const parsed = JSON.parse(activeProfileObj.layout_config)
      return {
        viewMode: parsed.viewMode ?? defaultLayout.viewMode,
        compactMode: parsed.compactMode ?? defaultLayout.compactMode,
        limitsMode: parsed.limitsMode ?? defaultLayout.limitsMode,
        limitsVariant: parsed.limitsVariant ?? defaultLayout.limitsVariant,
        autoMoveDisabled: parsed.autoMoveDisabled ?? defaultLayout.autoMoveDisabled,
        blocks: parsed.blocks || defaultLayout.blocks,
        modelBlocks: parsed.modelBlocks || defaultLayout.modelBlocks,
        archivedModels: parsed.archivedModels || defaultLayout.archivedModels
      }
    } catch (e) {
      console.error('Error parsing layout_config:', e)
      return defaultLayout
    }
  }, [activeProfileObj])

  // Reset local layout changes when baseline configuration changes
  useEffect(() => {
    setLocalLayout(null)
  }, [parsedLayout])

  const isSmartSortActive = activeProfileObj?.auto_sort != null


  // 3. Mutation to persist active profile changes
  const activeProfileMutation = useMutation({
    mutationFn: (profileId: number | null) =>
      apiFetch('/api/profiles/active', { method: 'POST', body: JSON.stringify({ profileId }) }),
    onMutate: async (newProfileId) => {
      await queryClient.cancelQueries({ queryKey: ['profiles', 'active'] })
      const previousProfile = queryClient.getQueryData(['profiles', 'active'])
      queryClient.setQueryData(['profiles', 'active'], { activeProfileId: newProfileId })
      return { previousProfile }
    },
    onError: (_err, _newProfileId, context) => {
      if (context?.previousProfile) {
        queryClient.setQueryData(['profiles', 'active'], context.previousProfile)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', 'active'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'token-usage'] })
    }
  })

  // 4. Sync initial active profile from backend
  useEffect(() => {
    if (activeProfileData && fetchedProfiles.length > 0) {
      if (activeProfileData.activeProfileId === null) {
        const defaultProf = fetchedProfiles.find(p => p.type === 'default' || p.type === 'builtin') || fetchedProfiles[0]
        if (defaultProf && activeProfile !== defaultProf.id) {
          setActiveProfile(defaultProf.id)
          activeProfileMutation.mutate(defaultProf.id)
        }
      } else if (activeProfileData.activeProfileId !== activeProfile && !activeProfileMutation.isPending) {
        setActiveProfile(activeProfileData.activeProfileId)
      }
      if (!isInitialized) setIsInitialized(true)
    }
  }, [activeProfileData, isInitialized, fetchedProfiles, activeProfile, activeProfileMutation.isPending])

  // Mutation to update profile details
  const updateProfileMutation = useMutation({
    mutationFn: (data: Partial<Omit<Profile, 'id' | 'type' | 'created_at'>>) => {
      return apiFetch(`/api/profiles/${activeProfile}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
  })

  const currentLayout = localLayout || parsedLayout;
  const viewMode = currentLayout.viewMode ?? 'kanban';
  const compactMode = currentLayout.compactMode ?? true;
  const autoMoveDisabled = currentLayout.autoMoveDisabled ?? false;
  const limitsMode = currentLayout.limitsMode ?? 'always';
  const limitsVariant = currentLayout.limitsVariant ?? 'c';

  function updateLayoutProp<K extends keyof LayoutConfig>(key: K, value: LayoutConfig[K], skipMutation = false) {
    const newLayout = { ...currentLayout, [key]: value };
    setLocalLayout(newLayout);
    if (activeProfileObj && !skipMutation) {
      updateProfileMutation.mutate({ layout_config: JSON.stringify(newLayout) });
    }
  }

  const setViewMode = (val: 'list' | 'grid' | 'kanban' | 'tier') => updateLayoutProp('viewMode', val);
  const setCompactMode = (val: boolean) => updateLayoutProp('compactMode', val);
  const setAutoMoveDisabled = (val: boolean) => updateLayoutProp('autoMoveDisabled', val);
  const setLimitsMode = (val: 'off' | 'hover' | 'always') => updateLayoutProp('limitsMode', val);
  const setLimitsVariant = (val: 'c' | 'a' | 'b') => updateLayoutProp('limitsVariant', val);

  // 5. Compute base entries dynamically based on active profile and auto_sort
  const baseEntries = useMemo(() => {
    if (!activeProfile || !profileModels) return globalEntries

    const profileModelMap = new Map(profileModels.map((pm: any) => [
      pm.model_db_id,
      { priority: pm.priority, enabled: pm.enabled },
    ]))

    const reordered = [...globalEntries].map(e => {
      const pm = profileModelMap.get(e.modelDbId)
      if (pm) {
        return { ...e, priority: pm.priority, enabled: pm.enabled }
      }
      return e
    })
    reordered.sort((a, b) => a.priority - b.priority)

    if (activeProfileObj?.auto_sort) {
      return sortEntriesByPreset(reordered, activeProfileObj.auto_sort)
    }

    return reordered
  }, [activeProfile, globalEntries, profileModels, activeProfileObj?.auto_sort])

  // 6. Update baseline reference and drop local edits when base changes
  useEffect(() => {
    if (baseEntries.length > 0) {
      const newBaseline = JSON.stringify(baseEntries.map(e => ({ id: e.modelDbId, priority: e.priority, enabled: e.enabled })))
      if (newBaseline !== baselineRef.current) {
        baselineRef.current = newBaseline
        setLocalEntries(null)
      }
    }
  }, [baseEntries])

  const allEntries = localEntries ?? baseEntries

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) => {
      if (activeProfile) {
        return apiFetch(`/api/profiles/${activeProfile}/reorder`, { method: 'PUT', body: JSON.stringify(data) })
      }
      return apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      if (activeProfile) queryClient.invalidateQueries({ queryKey: ['profiles', activeProfile, 'models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'token-usage'] })
      setLocalEntries(null)
    },
  })



  const archivedEntries = useMemo(() => {
    const archivedIds = currentLayout.archivedModels || []
    return allEntries.filter(e => archivedIds.includes(e.modelDbId))
  }, [allEntries, currentLayout.archivedModels])

  const availableProviders = useMemo(() => {
    const archivedIds = currentLayout.archivedModels || []
    const activeEntries = allEntries.filter(e => e.keyCount > 0 && !archivedIds.includes(e.modelDbId))
    const platforms = activeEntries.map(e => e.platform)
    return Array.from(new Set(platforms)).sort()
  }, [allEntries, currentLayout.archivedModels])

  let displayEntries = allEntries.filter(e => e.keyCount > 0 && !currentLayout.archivedModels?.includes(e.modelDbId))
  if (activeProviderFilters.length > 0) {
    displayEntries = displayEntries.filter(e => activeProviderFilters.includes(e.platform))
  }

  function handleCreateBlock() {
    const newId = 'block_' + Date.now();
    let highestDefault = 0;
    let hasDefault = false;
    currentLayout.blocks.forEach(b => {
      if (b.name === 'Default') hasDefault = true;
      else if (b.name.startsWith('Default_')) {
        const num = parseInt(b.name.split('_')[1], 10);
        if (!isNaN(num) && num > highestDefault) highestDefault = num;
      }
    });

    let newName = 'Default';
    if (hasDefault) newName = `Default_${highestDefault + 1}`;

    const newBlocks = [...currentLayout.blocks, { id: newId, name: newName }];
    updateLayoutProp('blocks', newBlocks, true);
  }

  function handleRenameBlock(id: string, newName: string) {
    const newBlocks = currentLayout.blocks.map(b => b.id === id ? { ...b, name: newName } : b);
    updateLayoutProp('blocks', newBlocks, true);
  }

  function handleDeleteBlock(id: string) {
    if (currentLayout.blocks.length <= 1) return;
    const blockIndex = currentLayout.blocks.findIndex(b => b.id === id);
    if (blockIndex === -1) return;

    // Move models to the previous block in order, or if deleting the first block, to the next block (index 1)
    const targetBlock = blockIndex > 0
      ? currentLayout.blocks[blockIndex - 1]
      : currentLayout.blocks[1];

    if (!targetBlock) return;

    const explicitModelBlocks = { ...currentLayout.modelBlocks };
    allEntries.forEach(e => {
      if (!explicitModelBlocks[e.modelDbId]) {
        explicitModelBlocks[e.modelDbId] = currentLayout.blocks[0].id;
      }
    });

    const modelsInDeletedBlock = allEntries.filter(e => explicitModelBlocks[e.modelDbId] === id);
    modelsInDeletedBlock.forEach(model => {
      explicitModelBlocks[model.modelDbId] = targetBlock.id;
    });

    let newEntries = [...(localEntries || baseEntries)];
    const deletedModelsIds = modelsInDeletedBlock.map(m => m.modelDbId);

    const modelsToMove = newEntries.filter(e => deletedModelsIds.includes(e.modelDbId));
    newEntries = newEntries.filter(e => !deletedModelsIds.includes(e.modelDbId));

    newEntries.push(...modelsToMove);
    newEntries = recomputePrioritiesByBlocks(newEntries, { ...currentLayout, blocks: currentLayout.blocks.filter(b => b.id !== id), modelBlocks: explicitModelBlocks });

    const newLayout = {
      ...currentLayout,
      blocks: currentLayout.blocks.filter(b => b.id !== id),
      modelBlocks: explicitModelBlocks
    };

    setLocalEntries(newEntries);
    setLocalLayout(newLayout);
  }

  function handleToggleBlock(id: string, enabled: boolean) {
    const blockModels = displayEntries.filter(e => {
      const bId = currentLayout.modelBlocks[e.modelDbId] || currentLayout.blocks[0]?.id;
      return bId === id;
    });
    const updated = allEntries.map(e => {
      if (blockModels.some(bm => bm.modelDbId === e.modelDbId)) {
        return { ...e, enabled };
      }
      return e;
    });
    setLocalEntries(updated);
  }

  function handleArchiveModel(modelDbId: number, e?: React.MouseEvent) {
    const entry = allEntries.find(ent => ent.modelDbId === modelDbId);
    if (e && entry) {
      const button = e.currentTarget as HTMLElement;
      const chipEl = button.closest('.group') as HTMLElement;
      if (chipEl) {
        const rect = chipEl.getBoundingClientRect();
        const startX = rect.left;
        const startY = rect.top;
        const width = rect.width;
        const height = rect.height;
        const key = Date.now() + Math.random();

        const animItem = {
          id: modelDbId,
          name: entry.displayName,
          platform: entry.platform,
          startX,
          startY,
          width,
          height,
          key,
          stage: 'start' as const,
          targetX: window.innerWidth - 60,
          targetY: window.innerHeight - 60,
        };

        setAnimatingArchives((prev) => [...prev, animItem]);
        setShowArchiveIndicator(true);

        setTimeout(() => {
          setAnimatingArchives((prev) =>
            prev.map((item) => (item.key === key ? { ...item, stage: 'end' as const } : item))
          );
        }, 20);

        setTimeout(() => {
          setAnimatingArchives((prev) => prev.filter((item) => item.key !== key));
        }, 900);

        if (archiveIndicatorTimeoutRef.current) {
          clearTimeout(archiveIndicatorTimeoutRef.current);
        }
        archiveIndicatorTimeoutRef.current = setTimeout(() => {
          setShowArchiveIndicator(false);
        }, 2000);
      }
    }

    const archived = new Set(currentLayout.archivedModels || []);
    archived.add(modelDbId);
    updateLayoutProp('archivedModels', Array.from(archived), true);
    handleToggle(modelDbId, false);
  }

  const unconfiguredPlatforms = [...new Set(allEntries.filter(e => e.keyCount === 0).map(e => e.platform))]

  function handleRestoreModel(modelDbId: number) {
    const archived = new Set(currentLayout.archivedModels || []);
    archived.delete(modelDbId);
    updateLayoutProp('archivedModels', Array.from(archived), true);
    handleToggle(modelDbId, false);
  }

  const isDndDisabled = isSmartSortActive || activeProviderFilters.length > 0

  // Apply auto-move-disabled sorting
  if (autoMoveDisabled) {
    const enabled = displayEntries.filter(e => e.enabled)
    const disabled = displayEntries.filter(e => !e.enabled)
    displayEntries = [...enabled, ...disabled]
  }

  // Compute display entries ordered by block for Kanban/Tier index numbering & legend sync
  const blockOrderedDisplayEntries = useMemo(() => {
    return recomputePrioritiesByBlocks(displayEntries, currentLayout)
  }, [displayEntries, currentLayout])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const collisionDetectionStrategy = useCallback<CollisionDetection>((args) => {
    // 1. First, check if the pointer is within any droppable container
    const pointerCollisions = pointerWithin(args);

    // Check if we have any chip collisions (numeric IDs) in the pointer collisions
    const chipCollisions = pointerCollisions.filter(c => typeof c.id === 'number');
    if (chipCollisions.length > 0) {
      return chipCollisions;
    }

    // 2. If no chips are directly under the pointer, check if we are over a block container (string ID)
    const blockCollisions = pointerCollisions.filter(c => typeof c.id === 'string');
    if (blockCollisions.length > 0) {
      const targetBlockId = blockCollisions[0].id;

      // Find all display entries that belong to this block
      const blockEntries = displayEntries.filter(e => (currentLayout.modelBlocks[e.modelDbId] || currentLayout.blocks[0]?.id) === targetBlockId);

      if (blockEntries.length > 0) {
        // Find all droppable containers for the chips in this block
        const blockChipIds = new Set(blockEntries.map(e => e.modelDbId));
        const blockContainers = args.droppableContainers.filter(c => blockChipIds.has(c.id as number));

        if (blockContainers.length > 0) {
          // Use closestCenter on just these block containers
          const closest = closestCenter({
            ...args,
            droppableContainers: blockContainers
          });
          if (closest.length > 0) {
            return closest;
          }
        }
      } else {
        // If the block is empty, return the block container itself so it can accept the item
        return blockCollisions;
      }
    }

    // 3. Fallback to closestCenter if pointer is outside containers
    return closestCenter(args);
  }, [displayEntries, currentLayout]);

  function handleDragCancel() {
    document.body.classList.remove('is-dragging-dnd');
    setGlobalIsDragging(false);
    setActiveId(null);
    dragStartEntriesRef.current = null;
    lastCrossBlockMoveTimeRef.current = 0;
  }

  function handleDragStart(event: DragStartEvent) {
    if (isSmartSortActive) return;
    document.body.classList.add('is-dragging-dnd');
    setGlobalIsDragging(true);
    setActiveId(event.active.id);
    dragStartEntriesRef.current = blockOrderedDisplayEntries;
  }

  function handleDragOver(event: DragOverEvent) {
    if (isSmartSortActive) return;
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as number;
    const overId = over.id;

    const activeBlockId = currentLayout.modelBlocks[activeId] || currentLayout.blocks[0]?.id;
    let overBlockId = activeBlockId;
    if (typeof overId === 'string') {
      overBlockId = overId;
    } else {
      overBlockId = currentLayout.modelBlocks[overId as number] || currentLayout.blocks[0]?.id;
    }

    if (activeBlockId !== overBlockId) {
      const now = Date.now();
      if (now - lastCrossBlockMoveTimeRef.current < 80) {
        return;
      }
      lastCrossBlockMoveTimeRef.current = now;

      crossBlockMoveRef.current = true;
      const newModelBlocks = { ...currentLayout.modelBlocks, [activeId]: overBlockId };
      updateLayoutProp('modelBlocks', newModelBlocks, true);

      setLocalEntries((prev) => {
        const entries = prev || baseEntries;
        const activeIndex = entries.findIndex(e => e.modelDbId === activeId);

        let overIndex = -1;
        if (typeof overId === 'number') {
          overIndex = entries.findIndex(e => e.modelDbId === overId);
        } else {
          // Dropping on empty block: position after models of preceding blocks
          const blockIdx = currentLayout.blocks.findIndex(b => b.id === overBlockId);
          const precedingBlockIds = new Set(currentLayout.blocks.slice(0, blockIdx).map(b => b.id));
          let lastPrecedingIdx = -1;
          for (let i = entries.length - 1; i >= 0; i--) {
            const entryBlock = currentLayout.modelBlocks[entries[i].modelDbId] || currentLayout.blocks[0]?.id;
            if (precedingBlockIds.has(entryBlock) && entries[i].keyCount > 0 && !currentLayout.archivedModels?.includes(entries[i].modelDbId)) {
              lastPrecedingIdx = i;
              break;
            }
          }
          overIndex = lastPrecedingIdx !== -1 ? lastPrecedingIdx + 1 : 0;
        }

        if (activeIndex !== -1 && overIndex !== -1) {
          return arrayMove(entries, activeIndex, overIndex);
        }
        return entries;
      });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    document.body.classList.remove('is-dragging-dnd');
    setGlobalIsDragging(false);
    setActiveId(null);
    dragStartEntriesRef.current = null;
    lastCrossBlockMoveTimeRef.current = 0;
    if (isSmartSortActive) return;
    const { active, over } = event;
    const wasCrossBlock = crossBlockMoveRef.current;
    crossBlockMoveRef.current = false;

    // Check if any move actually happened
    const isBlockMove = currentLayout.blocks.some(b => b.id === active.id) && over && active.id !== over.id;
    const isItemMove = over && active.id !== over.id && typeof over.id === 'number';

    if (!wasCrossBlock && !isBlockMove && !isItemMove) {
      return; // No movement occurred, do not set localEntries
    }

    setLocalEntries((prev) => {
      let current = [...(prev || baseEntries)];

      // Handle block reordering if dragging a block header
      if (isBlockMove) {
        const activeIndex = currentLayout.blocks.findIndex(b => b.id === active.id);
        const overIndex = currentLayout.blocks.findIndex(b => b.id === over.id);
        if (activeIndex !== -1 && overIndex !== -1) {
          const newBlocks = arrayMove(currentLayout.blocks, activeIndex, overIndex);
          updateLayoutProp('blocks', newBlocks, true);
        }
        return current;
      }

      // Only do arrayMove for within-block reordering;
      // cross-block moves were already handled by handleDragOver
      if (isItemMove) {
        const oldIndex = current.findIndex(e => e.modelDbId === active.id);
        const newIndex = current.findIndex(e => e.modelDbId === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          current = arrayMove(current, oldIndex, newIndex);
        }
      }

      return recomputePrioritiesByBlocks(current, currentLayout);
    });
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    const updated = allEntries.map(e =>
      e.modelDbId === modelDbId ? { ...e, enabled } : e
    )
    setLocalEntries(updated)
  }

  function handleSave() {
    if (!localEntries && !localLayout) return

    if (activeProfile && localLayout) {
      updateProfileMutation.mutate({ layout_config: JSON.stringify(localLayout) })
    }

    if (localEntries) {
      saveMutation.mutate(
        allEntries.map(e => {
          const pm = profileModels?.find((p: any) => p.model_db_id === e.modelDbId)
          const originalPriority = pm
            ? pm.priority
            : (globalEntries.find(g => g.modelDbId === e.modelDbId)?.priority ?? e.priority)

          return {
            modelDbId: e.modelDbId,
            priority: isSmartSortActive ? originalPriority : e.priority,
            enabled: e.enabled,
          }
        })
      )
    } else {
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
      setLocalLayout(null)
    }
  }

  function handleProfileClick(profileId: number) {
    if (activeProfile == profileId) {
      const defaultProf = fetchedProfiles.find(p => p.type === 'default' || p.type === 'builtin') || fetchedProfiles[0];
      if (defaultProf && activeProfile != defaultProf.id) {
        setActiveProfile(defaultProf.id);
        activeProfileMutation.mutate(defaultProf.id);
      }
      return;
    }
    setActiveProfile(profileId);
    activeProfileMutation.mutate(profileId);
  }

  // Preset sort helper
  function handleSort(preset: 'intelligence' | 'speed' | 'budget') {
    if (!allEntries) return
    const sorted = sortEntriesByPreset(allEntries, preset)
    setLocalEntries(sorted)
  }

  function handleSortClick(preset: 'intelligence' | 'speed' | 'budget') {
    if (isSmartSortActive) {
      updateProfileMutation.mutate({ auto_sort: preset })
    } else {
      handleSort(preset)
    }
  }

  function handleToggleAllExplicit(enabled: boolean) {
    const archivedIds = currentLayout.archivedModels || []
    const updated = allEntries.map(e =>
      e.keyCount > 0 && !archivedIds.includes(e.modelDbId) ? { ...e, enabled } : e
    )
    setLocalEntries(updated)
  }

  function handleToggleSmartSort(checked: boolean) {
    if (!activeProfile) return
    if (checked) {
      updateProfileMutation.mutate({ auto_sort: 'intelligence' })
    } else {
      // Simply clear auto_sort — profile returns to its stored manual order. No DB overwrite.
      updateProfileMutation.mutate({ auto_sort: null })
    }
  }

  const hasChangesChain = useMemo(() => {
    let entriesChanged = false;
    if (localEntries !== null) {
      const getBlockOrdered = (entries: FallbackEntry[], layout: LayoutConfig) => {
        const archivedIds = layout.archivedModels || [];
        const active = entries.filter(e => e.keyCount > 0 && !archivedIds.includes(e.modelDbId));
        
        if (layout.viewMode === 'list' || layout.viewMode === 'grid') {
          return active;
        }

        const blockOrdered: FallbackEntry[] = [];
        for (const block of layout.blocks) {
          const blockModels = active.filter(e => {
            const explicit = layout.modelBlocks[e.modelDbId];
            const validBlockId = explicit && layout.blocks.some(b => b.id === explicit) ? explicit : layout.blocks[0]?.id;
            return validBlockId === block.id;
          });
          blockOrdered.push(...blockModels);
        }
        const missing = active.filter(e => !blockOrdered.includes(e));
        return [...blockOrdered, ...missing];
      };

      const relevantLocal = getBlockOrdered(localEntries, currentLayout);
      const relevantBase = getBlockOrdered(baseEntries, parsedLayout);

      if (relevantLocal.length !== relevantBase.length) {
        entriesChanged = true;
      } else {
        for (let i = 0; i < relevantLocal.length; i++) {
          if (
            relevantLocal[i].modelDbId !== relevantBase[i].modelDbId ||
            relevantLocal[i].enabled !== relevantBase[i].enabled
          ) {
            entriesChanged = true;
            break;
          }
        }
      }
    }

    let layoutChanged = false;
    if (localLayout !== null) {
      if (JSON.stringify(localLayout.blocks) !== JSON.stringify(parsedLayout.blocks)) layoutChanged = true;
      else if (JSON.stringify(localLayout.archivedModels) !== JSON.stringify(parsedLayout.archivedModels)) layoutChanged = true;
      else {
        const defaultBlockId = parsedLayout.blocks[0]?.id || 'default_block_id';
        const allKeys = new Set([...Object.keys(localLayout.modelBlocks), ...Object.keys(parsedLayout.modelBlocks)]);
        for (const key of allKeys) {
          const k = Number(key);
          const localVal = localLayout.modelBlocks[k] || defaultBlockId;
          const parsedVal = parsedLayout.modelBlocks[k] || defaultBlockId;
          if (localVal !== parsedVal) {
            layoutChanged = true;
            break;
          }
        }
      }
    }

    return entriesChanged || layoutChanged;
  }, [localEntries, baseEntries, localLayout, parsedLayout, currentLayout]);

  return (
    <div className="pb-36">
      <style>{`
        .is-dragging-dnd [data-radix-popper-content-wrapper],
        .is-dragging-dnd [data-slot="tooltip-content"],
        .is-dragging-dnd .tooltip-content {
          display: none !important;
        }
      `}</style>
      <PageHeader
        title="Fallback chain"
        description="Drag to reorder. Requests try models top-to-bottom until one succeeds."
        actions={
          <div className="flex items-center gap-2">
            {activeProfile && (
              <div className="flex items-center gap-2 mr-2 border-r pr-3 border-border">
                <Switch
                  checked={isSmartSortActive}
                  onCheckedChange={handleToggleSmartSort}
                  id="smart-sort-switch"
                />
                <Tooltip>
                  <TooltipTrigger
                    delay={0}
                    render={
                      <label
                        htmlFor="smart-sort-switch"
                        className="text-xs font-medium text-muted-foreground cursor-pointer select-none flex items-center gap-1"
                      />
                    }
                  >
                    Smart Sorting <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground/60 cursor-help">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 16v-4" />
                      <path d="M12 8h.01" />
                    </svg>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[240px] text-center text-[10px] text-muted-foreground bg-popover px-2 py-1 leading-normal shadow-sm">
                    Automatically maintains the current top models when their specifications change. Manual sorting is disabled in this mode.
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            <Button
              variant={isSmartSortActive && activeProfileObj?.auto_sort === 'intelligence' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleSortClick('intelligence')}
              style={isSmartSortActive && activeProfileObj?.auto_sort === 'intelligence' && activeProfileObj.color ? { backgroundColor: activeProfileObj.color, borderColor: activeProfileObj.color } : {}}
              className={isSmartSortActive && activeProfileObj?.auto_sort === 'intelligence' ? 'text-white' : ''}
            >
              Intelligence
            </Button>
            <Button
              variant={isSmartSortActive && activeProfileObj?.auto_sort === 'speed' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleSortClick('speed')}
              style={isSmartSortActive && activeProfileObj?.auto_sort === 'speed' && activeProfileObj.color ? { backgroundColor: activeProfileObj.color, borderColor: activeProfileObj.color } : {}}
              className={isSmartSortActive && activeProfileObj?.auto_sort === 'speed' ? 'text-white' : ''}
            >
              Speed
            </Button>
            <Button
              variant={isSmartSortActive && activeProfileObj?.auto_sort === 'budget' ? 'default' : 'outline'}
              size="sm"
              onClick={() => handleSortClick('budget')}
              style={isSmartSortActive && activeProfileObj?.auto_sort === 'budget' && activeProfileObj.color ? { backgroundColor: activeProfileObj.color, borderColor: activeProfileObj.color } : {}}
              className={isSmartSortActive && activeProfileObj?.auto_sort === 'budget' ? 'text-white' : ''}
            >
              Budget
            </Button>
          </div>
        }
      />

      <div className="space-y-6">

        {/* Profiles section */}
        <div className="p-3 border rounded-lg bg-card/50 flex flex-col gap-0 relative group/profiles">
          <div
            className="transition-all duration-300 ease-in-out overflow-hidden"
            style={{
              maxHeight: profilesExpanded ? '1000px' : '32px'
            }}
          >
            <div
              ref={profilesContainerRef}
              className="flex flex-wrap items-center gap-2 justify-start"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProfilesModalOpen(true)}
                className="w-10 px-0 shrink-0 text-muted-foreground hover:text-foreground border-dashed bg-card hover:bg-muted/50"
                title="Configure profiles"
              >
                <Settings className="size-[15px] opacity-80" strokeWidth={2} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateModalOpen(true)}
                className="w-10 px-0 shrink-0 text-muted-foreground hover:text-foreground border-dashed bg-card hover:bg-muted/50"
                title="Create profile"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </Button>

              {profiles.map(p => (
                <Button
                  key={p.id}
                  variant={activeProfile == p.id ? 'default' : 'outline'}
                  size="sm"
                  style={{
                    ...(activeProfile == p.id && p.color && p.type !== 'default' ? { backgroundColor: p.color, borderColor: p.color } : {}),
                  }}
                  className={`max-w-[140px] min-w-[60px] justify-center truncate text-center transition-all ${activeProfile == p.id
                    ? 'text-white hover:opacity-90 font-medium shadow-sm'
                    : 'hover:border-foreground/40 bg-card hover:bg-muted/30'
                    }`}
                  onClick={() => handleProfileClick(p.id)}
                  title={p.name}
                >
                  {p.emoji && <span className="mr-1.5 shrink-0 text-sm leading-none">{p.emoji}</span>}
                  <span className="truncate">{p.name}</span>
                </Button>
              ))}
            </div>
          </div>

          {showBadge && (
            <div
              className="absolute -bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center opacity-90 hover:opacity-100 transition-opacity"
              onClick={() => setProfilesExpanded(!profilesExpanded)}
              title={profilesExpanded ? "Collapse profiles" : "Expand profiles"}
            >
              <button
                type="button"
                className={`transition-all duration-200 flex items-center justify-center font-bold shadow-sm ${profilesExpanded
                  ? 'size-6 rounded-full border bg-background hover:bg-muted text-muted-foreground'
                  : 'h-6 px-2.5 rounded-full border border-primary bg-primary text-primary-foreground hover:bg-primary/90 text-[10px]'
                  }`}
              >
                {profilesExpanded ? (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                ) : (
                  <span>+{hiddenCount}</span>
                )}
              </button>
            </div>
          )}
        </div>

        {tokenUsage && tokenUsage.totalBudget > 0 && (
          <TokenUsageBar
            data={tokenUsage}
            autoMoveDisabled={autoMoveDisabled}
            limitsMode={limitsMode}
            setLimitsMode={setLimitsMode}
            limitsVariant={limitsVariant}
            setLimitsVariant={setLimitsVariant}
            displayEntries={globalIsDragging && dragStartEntriesRef.current ? dragStartEntriesRef.current : blockOrderedDisplayEntries}
          />
        )}

        {/* Toolbar above the models list */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 border rounded-lg bg-card/30">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">View:</span>
              <div className="flex items-center gap-1 bg-muted p-1 rounded-lg">
                {[
                  { id: 'list', icon: AlignJustify, label: 'List' },
                  { id: 'grid', icon: LayoutGrid, label: 'Grid' },
                  { id: 'kanban', icon: KanbanIcon, label: 'Columns' },
                  { id: 'tier', icon: ListOrdered, label: 'Groups' },
                ].map((v) => (
                  <Tooltip key={v.id}>
                    <TooltipTrigger
                      delay={0}
                      render={
                        <button
                          onClick={() => setViewMode(v.id as typeof viewMode)}
                          className={`p-1.5 rounded-md transition-all flex items-center justify-center ${viewMode === v.id
                            ? 'bg-background text-foreground shadow-sm scale-105'
                            : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
                            }`}
                        />
                      }
                    >
                      <v.icon className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">{v.label}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>

            {(viewMode === 'kanban' || viewMode === 'tier') && (
              <div className="flex items-center gap-2 border-l pl-3 ml-1 animate-in fade-in duration-200">
                <Switch
                  checked={compactMode}
                  onCheckedChange={setCompactMode}
                  id="compact-mode"
                  className="scale-90"
                />
                <label htmlFor="compact-mode" className="text-xs text-muted-foreground select-none cursor-pointer">Compact view</label>
              </div>
            )}

            {/* Popover Filter */}
            <div className="relative">
              <button
                onClick={() => setFilterOpen(!filterOpen)}
                className={`h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors bg-card hover:bg-muted/50 ${activeProviderFilters.length > 0
                  ? 'border-primary/50 text-foreground bg-primary/5'
                  : 'text-muted-foreground hover:text-foreground border-border'
                  }`}
              >
                <Filter className="size-3.5" />
                <span>Providers</span>
                {activeProviderFilters.length > 0 && (
                  <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                    {activeProviderFilters.length}
                  </span>
                )}
              </button>

              {filterOpen && (
                <div
                  ref={filterPopoverRef}
                  className="absolute left-0 mt-1.5 z-30 w-56 rounded-xl border bg-popover p-2.5 shadow-xl animate-in fade-in slide-in-from-top-2 duration-150"
                >
                  <div className="flex items-center justify-between mb-2 pb-1.5 border-b px-1">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Filters</span>
                    {activeProviderFilters.length > 0 && (
                      <button
                        onClick={() => setActiveProviderFilters([])}
                        className="text-[10px] text-primary hover:underline font-medium"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1 pr-0.5">
                    {availableProviders.map(provider => {
                      const isChecked = activeProviderFilters.includes(provider)
                      return (
                        <label
                          key={provider}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/60 cursor-pointer select-none transition-colors"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setActiveProviderFilters(activeProviderFilters.filter(p => p !== provider))
                              } else {
                                setActiveProviderFilters([...activeProviderFilters, provider])
                              }
                            }}
                            className="size-3.5 rounded border-input text-primary focus:ring-primary cursor-pointer"
                          />
                          <div
                            className="size-2 rounded-full"
                            style={{ backgroundColor: platformColors[provider] ?? '#94a3b8' }}
                          />
                          <span className="text-xs capitalize font-medium text-foreground">{provider}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="inline-flex items-center rounded-lg border bg-card shadow-sm overflow-hidden shrink-0">
              <button
                onClick={() => handleToggleAllExplicit(false)}
                className="h-8 w-9 flex items-center justify-center bg-transparent hover:bg-muted text-muted-foreground hover:text-red-500 border-r border-border transition-colors"
                title="Disable all models"
              >
                <ToggleLeft className="size-4" />
              </button>
              <button
                onClick={() => handleToggleAllExplicit(true)}
                className="h-8 w-9 flex items-center justify-center bg-transparent hover:bg-muted text-muted-foreground hover:text-emerald-600 transition-colors"
                title="Enable all configured models"
              >
                <ToggleRight className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={autoMoveDisabled}
              onCheckedChange={setAutoMoveDisabled}
              id="auto-move-disabled"
            />
            <label htmlFor="auto-move-disabled" className="text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
              Disabled to bottom
            </label>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : displayEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No models available. Add API keys on the <a href="/keys" className="underline text-foreground">Keys page</a> first.
            </p>
          </div>
        ) : (
          <>
            {viewMode === 'kanban' || viewMode === 'tier' ? (
              <div className={`flex ${viewMode === 'kanban' ? 'gap-4 overflow-x-auto py-4 snap-x items-end kanban-board-scrollbar' : 'flex-col gap-3'}`}>
                <DndContext
                  sensors={sensors}
                  collisionDetection={collisionDetectionStrategy}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                  autoScroll={{
                    acceleration: 4,
                    layoutShiftCompensation: false,
                  }}
                >
                  {currentLayout.blocks.map(block => {
                    const blockEntries = displayEntries.filter(e => (currentLayout.modelBlocks[e.modelDbId] || currentLayout.blocks[0]?.id) === block.id);
                    const isBlockActive = activeId !== null && (
                      activeId === block.id ||
                      blockEntries.some(e => e.modelDbId === activeId)
                    );
                    return (
                      <BlockContainer
                        key={block.id}
                        block={block}
                        items={blockEntries.map(e => e.modelDbId)}
                        viewMode={viewMode}
                        onRename={handleRenameBlock}
                        onDelete={handleDeleteBlock}
                        onToggleAll={handleToggleBlock}
                        canDelete={currentLayout.blocks.length > 1}
                        isBlockActive={isBlockActive}
                      >
                        {blockEntries.map((entry) => (
                          <SortableModelChip
                            key={`${block.id}-${entry.modelDbId}`}
                            entry={entry}
                            index={blockOrderedDisplayEntries.findIndex(e => e.modelDbId === entry.modelDbId)}
                            isDndDisabled={isDndDisabled}
                            onToggle={handleToggle}
                            onArchive={handleArchiveModel}
                            viewMode={viewMode}
                            compactMode={compactMode}
                          />
                        ))}
                      </BlockContainer>
                    )
                  })}
                </DndContext>
                <div className={`shrink-0 flex items-center justify-center border-2 border-dashed rounded-lg opacity-50 hover:opacity-100 transition-opacity cursor-pointer hover:bg-muted/30 ${viewMode === 'kanban' ? 'w-12 min-h-[100px]' : 'h-12'}`} onClick={handleCreateBlock} title="Add block">
                  <Plus className="size-6 text-muted-foreground" />
                </div>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="w-full">
                <DndContext
                  sensors={sensors}
                  collisionDetection={collisionDetectionStrategy}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                  autoScroll={{
                    acceleration: 4,
                    layoutShiftCompensation: false,
                  }}
                >
                  <SortableContext
                    items={displayEntries.map(e => e.modelDbId)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {displayEntries.map((entry, index) => (
                        <SortableModelChip
                          key={entry.modelDbId}
                          entry={entry}
                          index={index}
                          isDndDisabled={isDndDisabled}
                          onToggle={handleToggle}
                          onArchive={handleArchiveModel}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            ) : (
              <div className="rounded-lg border divide-y overflow-hidden shadow-sm">
                <DndContext
                  sensors={sensors}
                  collisionDetection={collisionDetectionStrategy}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={handleDragCancel}
                  autoScroll={{
                    acceleration: 4,
                    layoutShiftCompensation: false,
                  }}
                >
                  <SortableContext
                    items={displayEntries.map(e => e.modelDbId)}
                    strategy={verticalListSortingStrategy}
                  >
                    {displayEntries.map((entry, index) => (
                      <SortableModelRow
                        key={entry.modelDbId}
                        entry={entry}
                        index={index}
                        isDndDisabled={isDndDisabled}
                        onToggle={handleToggle}
                        onArchive={handleArchiveModel}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {hasChangesChain && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-5 py-3 border rounded-2xl bg-background/95 backdrop-blur-md shadow-[0_12px_40px_-10px_rgba(0,0,0,0.3)] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-8 duration-300">
                <div className="flex flex-col mr-2 hidden sm:flex">
                  <span className="text-sm font-semibold leading-tight">Unsaved changes</span>
                  <span className="text-[11px] text-muted-foreground">You have modified the model order</span>
                </div>
                <div className="flex items-center gap-2 sm:ml-auto">
                  <Button variant="outline" size="sm" onClick={() => { setLocalEntries(null); setLocalLayout(null); }} className="h-8">
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saveMutation.isPending}
                    className="h-8 bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-900/20 border-transparent"
                  >
                    {saveMutation.isPending ? 'Saving…' : 'Save order'}
                  </Button>
                </div>
              </div>
            )}

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Hidden (no keys): {unconfiguredPlatforms.join(', ')}
              </p>
            )}

            {/* Collapsible Archive Panel */}
            <div className="border rounded-lg bg-card/20 mt-4 overflow-hidden">
              <button
                onClick={() => setArchiveExpanded(!archiveExpanded)}
                className="flex items-center justify-between w-full p-3 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors hover:bg-muted/20 select-none"
              >
                <div className="flex items-center gap-2">
                  <Archive className="size-3.5 animate-pulse" />
                  <span>Model Archive</span>
                  <span className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono font-bold">
                    {archivedEntries.length}
                  </span>
                </div>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className={`transition-transform duration-200 ${archiveExpanded ? 'rotate-180' : ''}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {archiveExpanded && (
                <div className="p-3 border-t bg-card/10">
                  {archivedEntries.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-4">Archive is empty</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      {archivedEntries.map(entry => (
                        <div
                          key={entry.modelDbId}
                          className="flex items-center justify-between p-2 rounded-lg border bg-card opacity-65 hover:opacity-100 transition-opacity"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="size-2 rounded-full shrink-0" style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }} />
                            <span className="text-xs font-medium truncate" title={entry.displayName}>
                              {entry.displayName}
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestoreModel(entry.modelDbId)}
                            className="h-7 px-2 text-[10px] gap-1 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          >
                            Restore
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      <ProfilesModal
        open={profilesModalOpen}
        onOpenChange={setProfilesModalOpen}
        activeProfileId={activeProfile}
        onActivate={handleProfileClick}
        localProfiles={localProfiles}
        setLocalProfiles={setLocalProfiles}
      />

      <CreateProfileModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        activeProfileId={activeProfile}
      />

      {/* Animating archive fly element */}
      {animatingArchives.map(item => {
        const isEnd = item.stage === 'end';
        return (
          <div
            key={item.key}
            style={{
              position: 'fixed',
              left: item.startX,
              top: item.startY,
              width: item.width,
              height: item.height,
              transform: isEnd
                ? `translate(${item.targetX - item.startX - item.width / 2}px, ${item.targetY - item.startY - item.height / 2}px) scale(0.1)`
                : 'translate(0, 0) scale(1)',
              opacity: isEnd ? 0.05 : 1,
              transition: 'transform 800ms cubic-bezier(0.22, 1, 0.36, 1), opacity 800ms ease-out',
              pointerEvents: 'none',
              zIndex: 99999,
            }}
            className="bg-card border rounded-lg shadow-lg flex items-center px-3 text-xs font-semibold overflow-hidden"
          >
            <span className="size-2 rounded-full shrink-0 mr-2" style={{ backgroundColor: platformColors[item.platform] ?? '#94a3b8' }} />
            <span className="truncate flex-1">{item.name}</span>
          </div>
        );
      })}

      {/* Pop-up status bar when archiving */}
      {showArchiveIndicator && (
        <div
          className="fixed bottom-6 right-6 md:right-10 bg-popover border border-border/80 text-foreground px-5 py-3 rounded-full shadow-2xl flex items-center gap-3 z-[9999] animate-in fade-in slide-in-from-bottom-5 duration-300 select-none"
          style={{
            boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
          }}
        >
          <div className="size-6 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center animate-bounce">
            <Archive className="size-3.5" />
          </div>
          <div className="flex flex-col">
            <span className="text-[11px] font-bold tracking-tight">Model archived</span>
            <span className="text-[9px] text-muted-foreground">Moved to the archive at the bottom of the page</span>
          </div>
        </div>
      )}
    </div>
  )
}
