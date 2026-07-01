import { useState, useMemo } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useSearchParams, useLocation, Link } from "react-router-dom"
import { PageHeader } from "@/components/page-header"
import { ModelsTabs } from "@/components/models-tabs"
import { Button } from "@/components/ui/button"
import { apiFetch } from "@/lib/api"
import { useI18n } from "@/i18n"
import { Switch } from "@/components/ui/switch"
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core"
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, ArrowLeft, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

interface AuxChainEntry {
  id: number
  task_type: string
  model_db_id: number
  priority: number
  enabled: number
  platform: string
  model_id: string
  display_name: string
  supports_vision: number
  supports_tools: number
  intelligence_rank: number | null
}

interface CatalogModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  supportsVision: number
  supportsTools: number
  intelligenceRank: number | null
  speedRank: number | null
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string | null
  contextWindow: number | null
}

// A row for "In Chain" — no toggle, just draggable
interface ChainRow {
  id: number
  platform: string
  model_id: string
  display_name: string
  supports_vision: number
  intelligence_rank: number | null
  priority: number
}

// A row for "Available" — has toggle to add/remove from chain
interface AvailableRow {
  id: number
  platform: string
  model_id: string
  display_name: string
  supports_vision: number
  supports_tools: number
  intelligence_rank: number | null
  speed_rank: number | null
  rpm_limit: number | null
  rpd_limit: number | null
  monthly_token_budget: string | null
  context_window: number | null
}

const taskMeta: Record<string, { label: string; description: string; color: string; filterVision: boolean }> = {
  vision: { label: "Vision", description: "Models for multimodal image/video understanding tasks", color: "blue", filterVision: true },
  coding: { label: "Coder", description: "Models for code generation and code understanding tasks", color: "purple", filterVision: false },
  webextract: { label: "WebExtract", description: "Models for web content extraction and summarization", color: "emerald", filterVision: false },
  embedding: { label: "Embedding", description: "Models for text embedding / vector representation", color: "amber", filterVision: false },
  tts: { label: "TTS", description: "Models for text-to-speech synthesis", color: "rose", filterVision: false },
  videogen: { label: "VideoGen", description: "Models for video generation", color: "orange", filterVision: false },
  imagegeneration: { label: "ImageGen", description: "Models for image generation", color: "cyan", filterVision: false },
  compression: { label: "Compression", description: "Models for context compression", color: "slate", filterVision: false },
  skillhub: { label: "SkillHub", description: "Models for skills hub search and recommendation", color: "violet", filterVision: false },
  approval: { label: "Approval", description: "Models for user approval and confirmation tasks", color: "teal", filterVision: false },
  mcp: { label: "MCP", description: "Models for Model Context Protocol interactions", color: "indigo", filterVision: false },
  tirlegen: { label: "Tirlegen", description: "Models for tireless regeneration and retry logic", color: "fuchsia", filterVision: false },
  curator: { label: "Curator", description: "Models for skill and content curation tasks", color: "lime", filterVision: false },
  general: { label: "General", description: "General purpose auxiliary tasks", color: "zinc", filterVision: false },
}

function formatTokens(toks: string | null): string {
  if (!toks) return '—'
  const num = parseInt(toks, 10)
  if (isNaN(num)) return toks
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`
  if (num >= 1e3) return `${(num / 1e3).toFixed(0)}K`
  return num.toString()
}

function SortableRow({ row, onToggle, disabled }: { row: ChainRow; onToggle: (id: number, v: boolean) => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-3 p-3 rounded-xl border bg-card hover:bg-card/80 transition-colors">
      <div {...attributes} {...listeners} className="cursor-grab text-muted-foreground">
        <GripVertical className="w-4 h-4" />
      </div>
      <span className="text-xs font-mono w-8 text-muted-foreground">#{row.priority ?? "-"}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{row.display_name || row.model_id}</span>
          <Badge variant="outline" className="text-[10px]">{row.platform}</Badge>
          {row.supports_vision && <Badge variant="default" className="text-[10px] bg-blue-500/20 text-blue-600 dark:text-blue-400">VL</Badge>}
          {row.intelligence_rank !== null && <Badge variant="outline" className="text-[10px]">IQ#{row.intelligence_rank}</Badge>}
        </div>
        <span className="text-xs text-muted-foreground font-mono">{row.model_id}</span>
      </div>
      <Switch checked={true} onCheckedChange={() => onToggle(row.id, false)} disabled={disabled} />
    </div>
  )
}


function AvailableModelRow({ row, onEnable, disabled }: { row: AvailableRow; onEnable: (id: number) => void; disabled: boolean }) {
  const contextStr = row.context_window ? `${(row.context_window / 1000).toFixed(0)}K ctx` : null
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border bg-card/50 hover:bg-card/80 transition-colors">
      <div className="w-4" />
      <span className="text-xs font-mono w-8 text-muted-foreground">-</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{row.display_name || row.model_id}</span>
          <span className="text-xs text-muted-foreground">{row.platform}</span>
          {row.supports_vision && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">Vision</span>
          )}
          {row.supports_tools && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">Tools</span>
          )}
          {row.intelligence_rank !== null && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-emerald-600/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-400">IQ#{row.intelligence_rank}</span>
          )}
          {row.speed_rank !== null && (
            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-amber-600/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">Speed#{row.speed_rank}</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground font-mono">{row.model_id}</span>
        <div className="text-[11px] text-muted-foreground/70 tabular-nums mt-0.5">
          {[
            parseInt(row.monthly_token_budget ?? '0', 10) > 0 ? `${formatTokens(row.monthly_token_budget)} tok/mo` : null,
            row.rpm_limit ? `${row.rpm_limit} RPM` : null,
            row.rpd_limit ? `${row.rpd_limit} RPD` : null,
            contextStr,
          ].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
      <Switch checked={false} onCheckedChange={() => onEnable(row.id)} disabled={disabled} />
    </div>
  )
}

export default function AuxiliaryPage() {
  const { t } = useI18n()
  const location = useLocation()
  const { pathname } = location
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState("")
  
  const pathMap: Record<string, string> = {
    "/models/vision": "vision", "/models/groups": "vision", "/models/coder": "coding", "/models/webextract": "webextract",
    "/models/tts": "tts", "/models/embedding": "embedding", "/models/imagegeneration": "imagegeneration",
    "/models/compression": "compression", "/models/general": "general", "/models/videogen": "videogen",
  }
  const taskType = searchParams.get("task") || pathMap[pathname] || "vision"
  const queryClient = useQueryClient()
  const meta = taskMeta[taskType] || { label: taskType, description: "", color: "zinc", filterVision: false }

  const { data: chainData, isLoading: chainLoading } = useQuery({
    queryKey: ["auxiliary", taskType],
    queryFn: () => apiFetch(`/api/auxiliary?task_type=${taskType}`),
  })
  const { data: catalogData, isLoading: catalogLoading } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => apiFetch("/api/models"),
  })

  // In-chain: enabled models for this task, sorted by priority
  const chainRows: ChainRow[] = useMemo(() => {
    const chain: AuxChainEntry[] = ((chainData as any)?.chain || []).filter(
      (e: AuxChainEntry) => e.task_type === taskType && e.enabled
    )
    return chain
      .sort((a, b) => a.priority - b.priority)
      .map(e => ({
        id: e.model_db_id, platform: e.platform, model_id: e.model_id, display_name: e.display_name,
        supports_vision: e.supports_vision, intelligence_rank: e.intelligence_rank, priority: e.priority,
      }))
  }, [chainData, taskType])

  // Available: ALL catalog models NOT in chain, sorted by intelligence_rank
  const allAvailable: AvailableRow[] = useMemo(() => {
    const chainIds = new Set(chainRows.map(r => r.id))
    return ((catalogData as any) || [])
      .filter((m: CatalogModel) => !chainIds.has(m.id) )
      .map((m: CatalogModel) => ({
        id: m.id, platform: m.platform, model_id: m.modelId, display_name: m.displayName,
        supports_vision: m.supportsVision, supports_tools: m.supportsTools, intelligence_rank: m.intelligenceRank,
        speed_rank: m.speedRank, rpm_limit: m.rpmLimit, rpd_limit: m.rpdLimit,
        monthly_token_budget: m.monthlyTokenBudget, context_window: m.contextWindow,
      }))
      .sort((a: any, b: any) => (a.intelligence_rank ?? 999) - (b.intelligence_rank ?? 999))
  }, [catalogData, chainRows])

  const filteredAvailable = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allAvailable
    return allAvailable.filter(r =>
      [r.display_name || "", r.model_id, r.platform].join(" ").toLowerCase().includes(q)
    )
  }, [allAvailable, search])

  // Pass taskType/chainData inline so the mutation always uses the latest values
  const toggleMutation = useMutation({
    mutationFn: async (payload: { modelDbId: number; enable: boolean; _taskType: string; _chainData: any }) => {
      const { modelDbId, enable, _taskType, _chainData } = payload
      if (enable) {
        await apiFetch("/api/auxiliary/add", {
          method: "POST",
          body: JSON.stringify({ task_type: _taskType, model_db_id: modelDbId }),
        })
      } else {
        const chain: AuxChainEntry[] = ((_chainData as any)?.chain || []).filter((e: AuxChainEntry) => e.task_type === _taskType)
        const ce = chain.find(e => e.model_db_id === modelDbId)
        if (ce) {
          if (ce.enabled) {
            await apiFetch(`/api/auxiliary/${modelDbId}`, {
              method: "PUT",
              body: JSON.stringify({ task_type: _taskType, enabled: 0 }),
            })
          } else {
            await apiFetch(`/api/auxiliary/${modelDbId}?task_type=${_taskType}`, { method: "DELETE" })
          }
        }
      }
    },
    onSuccess: (_var, variables) => {
      queryClient.invalidateQueries({ queryKey: ["auxiliary", variables._taskType] })
    },
  })

  function handleEnable(modelId: number) {
    toggleMutation.mutate({ modelDbId: modelId, enable: true, _taskType: taskType, _chainData: chainData })
  }

  function handleToggle(id: number, enable: boolean) {
    toggleMutation.mutate({ modelDbId: id, enable, _taskType: taskType, _chainData: chainData })
  }

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const saveMutation = useMutation({
    mutationFn: (entries: { modelDbId: number; priority: number; _taskType: string }[]) =>
      Promise.all(entries.map(e =>
        apiFetch(`/api/auxiliary/${e.modelDbId}`, { method: "PUT", body: JSON.stringify({ task_type: e._taskType, priority: e.priority }) })
      )),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auxiliary", taskType] }),
  })

  function handleDragEnd(event: any) {
    const { active, over } = event
    if (active.id !== over.id) {
      const oldIdx = chainRows.findIndex(e => e.id === active.id)
      const newIdx = chainRows.findIndex(e => e.id === over.id)
      const reordered = arrayMove(chainRows, oldIdx, newIdx)
      saveMutation.mutate(reordered.map((e, i) => ({ modelDbId: e.id, priority: i + 1, _taskType: taskType })))
    }
  }

  const badgeClass = (color: string) => {
    const colors: Record<string, string> = {
      blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
      purple: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
      emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
      orange: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
      cyan: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
      slate: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
      zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    }
    return colors[color] || colors.zinc
  }

  const loaded = !chainLoading && !catalogLoading
  const enabledCount = chainRows.filter(r => r.id).length
  const inChainCount = chainRows.length

  return (
    <div className="space-y-6">
      <ModelsTabs />
      <div className="flex items-center justify-between mb-4">
        <PageHeader title={meta.label} description={meta.description} badge={{ label: t("auxiliary.newBadge"), className: badgeClass(meta.color) }} divider={false} />
        <Link to="/models/chat">
          <Button variant="ghost" size="sm" className="gap-1 text-xs">
            <ArrowLeft className="w-3.5 h-3.5" />{t("common.back")}
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(taskMeta).map(([key, m]) => (
          <Link key={key} to={`/models/groups${key !== "vision" ? `?task=${key}` : ""}`}>
            <span className={`inline-block px-2.5 py-1 rounded-lg text-xs cursor-pointer transition-colors ${key === taskType ? badgeClass(m.color) + " font-medium ring-1 ring-current" : "text-muted-foreground hover:text-foreground"}`}>
              {m.label}
            </span>
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search models..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 pl-9 pr-8 text-sm" />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {loaded && <div className="text-xs text-muted-foreground shrink-0">{filteredAvailable.length} available · {inChainCount} in chain · {enabledCount} enabled</div>}
      </div>

      {!loaded ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : filteredAvailable.length === 0 && inChainCount === 0 ? (
        <div className="text-sm text-muted-foreground text-center py-12">{t("auxiliary.noModels")}</div>
      ) : (
        <div className="space-y-4">
          {chainRows.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">In Chain ({chainRows.length})</div>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={chainRows.map(e => e.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-2">
                    {chainRows.map(row => <SortableRow key={row.id} row={row} onToggle={handleToggle} disabled={toggleMutation.isPending} />)}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}
          {filteredAvailable.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Available ({filteredAvailable.length})</div>
              <div className="space-y-2">
                {filteredAvailable.map(row => (
                  <AvailableModelRow key={row.id} row={row} onEnable={handleEnable} disabled={toggleMutation.isPending} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loaded && inChainCount > 0 && (
        <div className="p-4 rounded-xl bg-muted/50 border">
          <div className="text-xs font-medium mb-1">{t("auxiliary.activeModel")}: </div>
          {chainRows.slice(0, 3).map(r => (
            <div key={r.id} className="text-sm">{r.display_name || r.model_id} ({r.platform}) <span className="text-muted-foreground text-xs">#{r.priority}</span></div>
          ))}
          <div className="text-xs text-muted-foreground mt-2">
            {t("auxiliary.totalModels")}: {inChainCount} | {t("auxiliary.enabled")}: {enabledCount}
          </div>
        </div>
      )}
    </div>
  )
}
