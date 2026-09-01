import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'

type GeminiFamily = 'default' | 'pro' | 'flash' | 'flashLite'
type GeminiMap = Record<GeminiFamily, string>
type OllamaMode = 'off' | 'open-loopback' | 'key-required'

interface Compatibility {
  ollamaEmulation: OllamaMode
  exposeClaudeDiscoveryAliases: boolean
}

interface MappableModel {
  modelId: string
  displayName: string
  enabled: boolean
}

interface UrlToken {
  id: number
  label: string
  tokenPrefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  token?: string
}

const families: Array<{ key: GeminiFamily; labelKey: string }> = [
  { key: 'default', labelKey: 'keys.familyDefault' },
  { key: 'pro', labelKey: 'keys.familyGeminiPro' },
  { key: 'flash', labelKey: 'keys.familyGeminiFlash' },
  { key: 'flashLite', labelKey: 'keys.familyGeminiFlashLite' },
]

export function AgentCompatibilitySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [tokenLabel, setTokenLabel] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const { data: mapData } = useQuery<{ map: GeminiMap }>({
    queryKey: ['gemini-map'],
    queryFn: () => apiFetch('/api/settings/gemini-map'),
  })
  const { data: compatibility } = useQuery<Compatibility>({
    queryKey: ['agent-compatibility'],
    queryFn: () => apiFetch('/api/settings/agent-compatibility'),
  })
  const { data: models = [] } = useQuery<MappableModel[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: tokenData } = useQuery<{ tokens: UrlToken[] }>({
    queryKey: ['url-tokens'],
    queryFn: () => apiFetch('/api/settings/url-tokens'),
  })
  const [mapDraft, setMapDraft] = useState<GeminiMap | null>(null)
  const displayedMap = mapDraft ?? mapData?.map ?? null

  const saveMap = useMutation({
    mutationFn: (map: GeminiMap) => apiFetch('/api/settings/gemini-map', {
      method: 'PUT',
      body: JSON.stringify(map),
    }),
    onSuccess: () => {
      setMapDraft(null)
      queryClient.invalidateQueries({ queryKey: ['gemini-map'] })
    },
  })
  const saveCompatibility = useMutation({
    mutationFn: (patch: Partial<Compatibility>) => apiFetch('/api/settings/agent-compatibility', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-compatibility'] }),
  })
  const createToken = useMutation({
    mutationFn: () => apiFetch<UrlToken>('/api/settings/url-tokens', {
      method: 'POST',
      body: JSON.stringify({ label: tokenLabel }),
    }),
    onSuccess: token => {
      setNewToken(token.token ?? null)
      setTokenLabel('')
      queryClient.invalidateQueries({ queryKey: ['url-tokens'] })
    },
  })
  const revokeToken = useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/api/settings/url-tokens/${id}`, {
      method: 'DELETE',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['url-tokens'] }),
  })
  const options = Array.from(new Map(
    models.filter(model => model.enabled).map(model => [model.modelId, model]),
  ).values()).sort((a, b) => a.displayName.localeCompare(b.displayName))
  const mapDirty = !!mapDraft && !!mapData
    && JSON.stringify(mapDraft) !== JSON.stringify(mapData.map)

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border bg-card p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium">{t('keys.geminiTitle')}</h2>
            <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{t('keys.geminiDesc')}</p>
          </div>
          <Button
            size="sm"
            disabled={!mapDirty || saveMap.isPending}
            onClick={() => mapDraft && saveMap.mutate(mapDraft)}
          >
            {t('common.save')}
          </Button>
        </div>
        <div className="space-y-2">
          {families.map(family => (
            <div key={family.key} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-xs font-medium">{t(family.labelKey)}</span>
              <Select
                value={displayedMap?.[family.key] ?? 'auto'}
                onValueChange={value => setMapDraft(current =>
                  ({ ...(current ?? displayedMap ?? {
                    default: 'auto',
                    pro: 'auto',
                    flash: 'auto',
                    flashLite: 'auto',
                  }), [family.key]: value }))}
              >
                <SelectTrigger className="w-[320px] max-w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('keys.anthropicAuto')}</SelectItem>
                  {options.map(model => (
                    <SelectItem key={model.modelId} value={model.modelId}>{model.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border bg-card p-5">
        <h2 className="text-sm font-medium">{t('keys.compatibilityTitle')}</h2>
        <p className="mt-0.5 mb-4 max-w-prose text-xs text-muted-foreground">{t('keys.compatibilityDesc')}</p>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium">{t('keys.ollamaMode')}</p>
              <p className="text-xs text-muted-foreground">{t('keys.ollamaModeHint')}</p>
            </div>
            <Select
              value={compatibility?.ollamaEmulation ?? 'off'}
              onValueChange={value => saveCompatibility.mutate({ ollamaEmulation: value as OllamaMode })}
            >
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t('keys.ollamaOff')}</SelectItem>
                <SelectItem value="open-loopback">{t('keys.ollamaLoopback')}</SelectItem>
                <SelectItem value="key-required">{t('keys.ollamaKeyRequired')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium">{t('keys.claudeAliases')}</p>
              <p className="text-xs text-muted-foreground">{t('keys.claudeAliasesHint')}</p>
            </div>
            <Switch
              checked={compatibility?.exposeClaudeDiscoveryAliases ?? false}
              onCheckedChange={checked =>
                saveCompatibility.mutate({ exposeClaudeDiscoveryAliases: checked })}
            />
          </div>
        </div>
      </section>

      <section className="rounded-3xl border bg-card p-5">
        <h2 className="text-sm font-medium">{t('keys.urlTokensTitle')}</h2>
        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{t('keys.urlTokensDesc')}</p>
        <div className="my-4 flex gap-2">
          <Input
            value={tokenLabel}
            onChange={event => setTokenLabel(event.target.value)}
            placeholder={t('keys.urlTokenLabel')}
            className="max-w-xs"
          />
          <Button size="sm" onClick={() => createToken.mutate()} disabled={createToken.isPending}>
            {t('keys.createUrlToken')}
          </Button>
        </div>
        {newToken && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="mb-2 text-xs text-muted-foreground">{t('keys.urlTokenOnce')}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{newToken}</code>
              <CopyButton text={newToken} className="size-7 shrink-0" label={t('common.copy')} />
            </div>
          </div>
        )}
        <div className="space-y-2">
          {(tokenData?.tokens ?? []).map(token => (
            <div key={token.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2">
              <div>
                <p className="text-xs font-medium">{token.label || token.tokenPrefix}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{token.tokenPrefix}</p>
              </div>
              {token.revokedAt ? (
                <span className="text-xs text-muted-foreground">{t('keys.revoked')}</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revokeToken.isPending}
                  onClick={() => revokeToken.mutate(token.id)}
                >
                  {t('keys.revoke')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
