import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'

// Claude (Anthropic) model families the mapping editor exposes. Anthropic
// clients send these names; each maps to "auto" (router picks a free model) or
// a pinned catalog model. Mirrors services/anthropic-map.ts on the server.
type ClaudeFamily = 'default' | 'opus' | 'sonnet' | 'haiku'
type AnthropicMap = Record<ClaudeFamily, string>
interface MappableModel { modelId: string; displayName: string; enabled: boolean }
const FAMILY_ORDER: { key: ClaudeFamily; labelKey: string }[] = [
  { key: 'default', labelKey: 'keys.familyDefault' },
  { key: 'opus', labelKey: 'keys.familyOpus' },
  { key: 'sonnet', labelKey: 'keys.familySonnet' },
  { key: 'haiku', labelKey: 'keys.familyHaiku' },
]

// Claude (Anthropic) model mapping: point a Claude / Anthropic SDK client at
// this server and decide how its built-in model names route into the free pool.
export function AnthropicSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Anthropic clients append `/v1/messages` to the base URL, so they want the
  // bare origin (OpenAI clients use origin + /v1, shown in the key section).
  const origin = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}`
    : window.location.origin

  const { data: mapData } = useQuery<{ map: AnthropicMap }>({
    queryKey: ['anthropic-map'],
    queryFn: () => apiFetch('/api/settings/anthropic-map'),
  })
  const { data: models = [] } = useQuery<MappableModel[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const [draft, setDraft] = useState<AnthropicMap | null>(null)
  useEffect(() => { if (mapData?.map) setDraft(mapData.map) }, [mapData])

  const save = useMutation({
    mutationFn: (map: AnthropicMap) => apiFetch('/api/settings/anthropic-map', { method: 'PUT', body: JSON.stringify(map) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['anthropic-map'] }),
  })

  // Dedup catalog models by id; only enabled models can be pinned.
  const modelOptions = Array.from(new Map(models.filter(m => m.enabled).map(m => [m.modelId, m])).values())
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const dirty = !!(draft && mapData?.map && JSON.stringify(draft) !== JSON.stringify(mapData.map))

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.anthropicTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">{t('keys.anthropicDesc')}</p>
        </div>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => draft && save.mutate(draft)}>
          {save.isSuccess && !dirty ? t('keys.anthropicSaved') : t('keys.anthropicSave')}
        </Button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs mb-4">
        <span className="text-muted-foreground">{t('keys.anthropicBaseUrl')}</span>
        <code className="font-mono break-all">{origin}</code>
        <span className="text-muted-foreground">{t('keys.anthropicAuth')}</span>
        <code className="font-mono">x-api-key</code>
      </div>

      <div className="space-y-2">
        {FAMILY_ORDER.map(({ key, labelKey }) => (
          <div key={key} className="flex items-center gap-3">
            <span className="w-40 text-xs font-medium shrink-0">{t(labelKey)}</span>
            <Select
              value={draft?.[key] ?? 'auto'}
              onValueChange={(v) => setDraft(d => (d ? { ...d, [key]: v } : d))}
            >
              <SelectTrigger className="w-[320px] max-w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('keys.anthropicAuto')}</SelectItem>
                {/* Keep a currently-pinned-but-now-disabled model selectable. */}
                {draft?.[key] && draft[key] !== 'auto' && !modelOptions.some(m => m.modelId === draft[key]) && (
                  <SelectItem value={draft[key]}>{draft[key]}</SelectItem>
                )}
                {modelOptions.map(m => (
                  <SelectItem key={m.modelId} value={m.modelId}>{m.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground mt-4 max-w-prose">{t('keys.anthropicNote')}</p>
    </section>
  )
}
