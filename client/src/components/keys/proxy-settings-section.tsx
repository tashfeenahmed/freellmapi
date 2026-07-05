import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Globe } from 'lucide-react'
import { useI18n } from '@/i18n'

export function ProxySettingsSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [proxyUrl, setProxyUrl] = useState('')

  const { data, isError } = useQuery<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>({
    queryKey: ['proxy-url'],
    queryFn: () => apiFetch('/api/settings/proxy'),
  })

  // Sync from server when the query refetches; keep the user's typed value
  // in between (controlled input).
  useEffect(() => {
    if (data) setProxyUrl(data.proxyUrl)
  }, [data?.proxyUrl])

  const saveProxy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { proxyUrl?: string; enabled?: boolean; bypassPlatforms?: string[] }) =>
      apiFetch<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>('/api/settings/proxy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (result: { proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ['proxy-url'] })
      setProxyUrl(result.proxyUrl)
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    saveProxy.mutate({ proxyUrl })
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
        <form onSubmit={submit} className="flex items-end gap-3">
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs">{t('keys.proxyUrl')}</Label>
            <Input
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder="socks5://127.0.0.1:1080"
              className="font-mono text-xs"
            />
          </div>
          <Button type="submit" size="sm" disabled={saveProxy.isPending}>
            {saveProxy.isPending ? t('keys.savingProxy') : t('keys.saveProxy')}
          </Button>
        </form>
      )}

      {saveProxy.isError && (
        <p className="text-destructive text-xs mt-2">{(saveProxy.error as Error).message}</p>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        <p>
          {t('keys.proxyEnvHintBefore')}<code className="font-mono">PROXY_URL</code>{t('keys.proxyEnvHintAfter')}
        </p>
        <ul className="list-disc list-inside mt-1 space-y-0.5">
          <li><code className="font-mono">socks5://127.0.0.1:1080</code></li>
          <li><code className="font-mono">http://proxy.corp.com:8080</code></li>
          <li><code className="font-mono">socks5://user:pass@proxy:1080</code></li>
        </ul>
      </div>
    </section>
  )
}
