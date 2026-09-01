import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Globe } from 'lucide-react'
import { useI18n } from '@/i18n'
import { PLATFORMS, CUSTOM_GROUP } from './shared'
import type { ApiKey } from '../../../../shared/types'
import type { ProxyMode } from '../../../../shared/types'

interface ProxySettings {
  proxyUrl: string
  proxyMode: ProxyMode
  fetchRelayTokenConfigured: boolean
  enabled: boolean
  bypassPlatforms: string[]
  active: boolean
}

/** Host of a probe target, for display. Falls back to the raw value so a
 *  malformed override still shows something rather than vanishing. */
function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

export function ProxySettingsSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyMode, setProxyMode] = useState<ProxyMode>('forward')
  const [fetchRelayToken, setFetchRelayToken] = useState('')
  const [fetchRelayTokenChanged, setFetchRelayTokenChanged] = useState(false)

  const { data, isError } = useQuery<ProxySettings>({
    queryKey: ['proxy-url'],
    queryFn: () => apiFetch('/api/settings/proxy'),
  })

  // #825: the per-platform route-via-proxy switch used to live only inside the
  // group dropdown on the Providers tab (two clicks per platform, no bulk, and
  // no way to see which platforms route through the proxy at a glance). Render
  // the same bypass list here as visible switches, one per platform that has
  // keys — custom endpoints included, so they get a per-endpoint-style toggle
  // instead of being lumped into a group.
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  // Sync from server when the query refetches; keep the user's typed value
  // in between (controlled input).
  useEffect(() => {
    if (data) {
      setProxyUrl(data.proxyUrl)
      setProxyMode(data.proxyMode)
    }
  }, [data?.proxyUrl, data?.proxyMode])

  const saveProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { proxyUrl?: string; proxyMode?: ProxyMode; fetchRelayToken?: string; enabled?: boolean; bypassPlatforms?: string[] }) =>
      apiFetch<ProxySettings>('/api/settings/proxy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (result: ProxySettings) => {
      queryClient.invalidateQueries({ queryKey: ['proxy-url'] })
      setProxyUrl(result.proxyUrl)
      setProxyMode(result.proxyMode)
      setFetchRelayToken('')
      setFetchRelayTokenChanged(false)
    },
  })

  // #863: test the DRAFT proxy URL (or the saved one when the input is empty)
  // without saving anything. Result shown inline; failures carry the reason.
  const testProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { proxyUrl?: string; proxyMode?: ProxyMode; fetchRelayToken?: string }) =>
      apiFetch<{ ok: boolean; latencyMs: number; status?: number; error?: string; target?: string }>('/api/settings/proxy/test', { method: 'POST', body: JSON.stringify(body) }),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    saveProxy.mutate({
      proxyUrl,
      proxyMode,
      ...(fetchRelayTokenChanged ? { fetchRelayToken } : {}),
    })
  }

  const enabled = data?.enabled ?? true
  const active = data?.active ?? false

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Globe className="size-3.5 text-muted-foreground" />
            {t('keys.outboundProxy')}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.outboundProxyDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => saveProxy.mutate({ enabled: checked })}
            disabled={saveProxy.isPending || !data}
          />
          {active && enabled && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
              {t('common.active')}
            </span>
          )}
        </div>
      </div>

      {isError ? (
        <p className="text-xs text-muted-foreground">{t('keys.proxyLoadFailed')}</p>
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.proxyMode')}</Label>
            <Select value={proxyMode} onValueChange={value => setProxyMode(value as ProxyMode)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="forward" label={t('keys.proxyModeForward')}>{t('keys.proxyModeForward')}</SelectItem>
                <SelectItem value="fetch-relay" label={t('keys.proxyModeFetchRelay')}>{t('keys.proxyModeFetchRelay')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs">{t('keys.proxyUrl')}</Label>
            <Input
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder={proxyMode === 'fetch-relay' ? 'https://relay.example.workers.dev' : 'socks5://127.0.0.1:1080'}
              className="font-mono text-xs"
            />
          </div>
          {proxyMode === 'fetch-relay' && (
            <div className="space-y-1.5 flex-1">
              <Label className="text-xs">{t('keys.relayToken')}</Label>
              <Input
                type="password"
                autoComplete="new-password"
                value={fetchRelayToken}
                onChange={e => {
                  setFetchRelayToken(e.target.value)
                  setFetchRelayTokenChanged(true)
                }}
                placeholder={data?.fetchRelayTokenConfigured ? t('keys.relayTokenConfigured') : t('keys.relayTokenPlaceholder')}
                className="font-mono text-xs"
              />
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testProxy.isPending}
            onClick={() => testProxy.mutate({
              proxyUrl,
              proxyMode,
              ...(fetchRelayToken ? { fetchRelayToken } : {}),
            })}
          >
            {testProxy.isPending ? t('keys.testingProxy') : t('keys.testProxy')}
          </Button>
          <Button type="submit" size="sm" disabled={saveProxy.isPending}>
            {saveProxy.isPending ? t('keys.savingProxy') : t('keys.saveProxy')}
          </Button>
        </form>
      )}

      {testProxy.isSuccess && (
        <p className={`text-xs mt-2 ${testProxy.data.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
          {testProxy.data.ok
            ? t('keys.proxyTestOk', { ms: String(testProxy.data.latencyMs) })
            : t('keys.proxyTestFail', { reason: testProxy.data.error ?? '' })}
          {/* Which endpoint was probed. A pass or a fail is only actionable if
              you know what was reached — and the target varies with the keys
              you hold. A bare host name needs no translation. */}
          {testProxy.data.target && (
            <span className="text-muted-foreground ml-1.5 font-mono">
              {hostOf(testProxy.data.target)}
            </span>
          )}
        </p>
      )}
      {testProxy.isError && (
        <p className="text-destructive text-xs mt-2">{(testProxy.error as Error).message}</p>
      )}

      {saveProxy.isError && (
        <p className="text-destructive text-xs mt-2">{(saveProxy.error as Error).message}</p>
      )}

      {/* #825: visible per-platform route-via-proxy switches, one per platform
          that has keys. checked = routed through the proxy (not in the bypass
          list), matching the semantic of the old Providers-tab dropdown item. */}
      {!isError && enabled && keys.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="text-xs font-medium mb-2">{t('keys.routeViaProxy')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {[...PLATFORMS, CUSTOM_GROUP]
              .filter(p => keys.some(k => k.platform === p.value))
              .map(p => {
                const routed = !(data?.bypassPlatforms ?? []).includes(p.value)
                return (
                  <label key={p.value} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate">{p.label}</span>
                    <Switch
                      size="sm"
                      checked={routed}
                      disabled={saveProxy.isPending || !data}
                      onCheckedChange={(checked) => {
                        const next = checked
                          ? (data?.bypassPlatforms ?? []).filter(x => x !== p.value)
                          : [...(data?.bypassPlatforms ?? []), p.value]
                        saveProxy.mutate({ bypassPlatforms: next })
                      }}
                    />
                  </label>
                )
              })}
          </div>
        </div>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        <p>
          {t('keys.proxyEnvHintBefore')}<code className="font-mono">PROXY_URL</code>{t('keys.proxyEnvHintAfter')}
        </p>
        {proxyMode === 'fetch-relay' ? (
          <p className="mt-1">
            {t('keys.relayHeadersHint')}{' '}
            <code className="font-mono">Fetch-Relay-Target</code>
            {' + '}
            <code className="font-mono">Fetch-Relay-Authorization</code>
          </p>
        ) : (
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            <li><code className="font-mono">socks5://127.0.0.1:1080</code></li>
            <li><code className="font-mono">socks5h://127.0.0.1:1080</code></li>
            <li><code className="font-mono">http://proxy.corp.com:8080</code></li>
            <li><code className="font-mono">socks5://user:pass@proxy:1080</code></li>
          </ul>
        )}
      </div>
    </section>
  )
}
