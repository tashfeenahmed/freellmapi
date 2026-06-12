import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

interface LicenseStatus {
  valid: boolean
  plan: 'annual' | 'lifetime' | null
  status: string | null
  expiresAt: string | null
  cancelAtPeriodEnd?: boolean
  reason?: string
  checkedAtMs: number
}

interface CatalogSyncState {
  baseUrl: string
  appliedVersion: string | null
  appliedTier: string | null
  lastSyncMs: number | null
  lastError: string | null
}

interface PremiumStatus {
  hasKey: boolean
  maskedKey: string | null
  license: LicenseStatus | null
  catalog: CatalogSyncState
  siteUrl: string
}

const PLAN_LABEL: Record<string, string> = {
  annual: 'Premium Annual',
  lifetime: 'Premium Lifetime',
}

function fmtWhen(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString()
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function PremiumPage() {
  const queryClient = useQueryClient()
  const [keyInput, setKeyInput] = useState('')

  const { data, isLoading } = useQuery<PremiumStatus>({
    queryKey: ['premium'],
    queryFn: () => apiFetch('/api/premium'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['premium'] })
    // A sync may have changed the model list and quirks.
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const activate = useMutation({
    mutationFn: (key: string) =>
      apiFetch('/api/premium/key', { method: 'POST', body: JSON.stringify({ key }) }),
    onSuccess: () => {
      setKeyInput('')
      invalidate()
    },
  })

  const removeKey = useMutation({
    mutationFn: () => apiFetch('/api/premium/key', { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const syncNow = useMutation({
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: invalidate,
  })

  const openPortal = useMutation({
    mutationFn: () => apiFetch<{ url: string }>('/api/premium/portal', { method: 'POST' }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener')
    },
  })

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="Premium" description="The live model catalog, on every device." />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  const { hasKey, maskedKey, license, catalog, siteUrl } = data
  const live = catalog.appliedTier === 'live'
  const licensed = hasKey && license?.valid

  return (
    <div>
      <PageHeader
        title="Premium"
        description="The live model catalog, on every device."
        actions={
          <Button variant="outline" size="sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
            <RefreshCw className={syncNow.isPending ? 'animate-spin' : ''} />
            {syncNow.isPending ? 'Syncing…' : 'Check for updates'}
          </Button>
        }
      />

      <div className="space-y-8">
        {/* Catalog feed state */}
        <section>
          <h2 className="text-sm font-medium mb-3">Catalog feed</h2>
          <div className="rounded-3xl border bg-card p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className={`inline-block size-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                <span className="text-sm font-medium">{live ? 'Live feed' : 'Monthly snapshot'}</span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {catalog.appliedVersion ?? 'bundled'}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">Last checked: {fmtWhen(catalog.lastSyncMs)}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {live
                ? 'New free models, quota changes, and quirk fixes land here within hours of being shipped. The app checks automatically twice a day; nothing to do.'
                : 'Free tier: the catalog refreshes from a monthly snapshot, checked automatically twice a day. Premium switches this to the live feed, updated every 2-3 days.'}
            </p>
            {catalog.lastError && (
              <p className="text-destructive text-xs mt-2">Last sync problem: {catalog.lastError}</p>
            )}
          </div>
        </section>

        {/* License */}
        <section>
          <h2 className="text-sm font-medium mb-3">License</h2>
          {hasKey ? (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{maskedKey}</span>
                {licensed ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent">
                    {PLAN_LABEL[license?.plan ?? ''] ?? 'Premium'}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/40">
                    {license?.reason === 'expired' ? 'Expired' : 'Inactive'}
                  </Badge>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {licensed && license?.plan === 'lifetime' && 'Lifetime license: never expires.'}
                {licensed && license?.plan === 'annual' && !license.cancelAtPeriodEnd && license.expiresAt &&
                  `Renews on ${fmtDate(license.expiresAt)}.`}
                {licensed && license?.plan === 'annual' && license.cancelAtPeriodEnd && license.expiresAt &&
                  `Will not renew. Premium until ${fmtDate(license.expiresAt)}, then this install falls back to the free monthly catalog.`}
                {!licensed &&
                  'This key is no longer active. The app keeps working on the free monthly catalog.'}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
                  <ExternalLink />
                  {openPortal.isPending ? 'Opening…' : 'Manage subscription'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeKey.mutate()}
                  disabled={removeKey.isPending}
                  className="text-muted-foreground"
                >
                  Remove key from this device
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Manage subscription opens Stripe&apos;s billing portal: cancel, update your card, or download
                invoices. Removing the key only deactivates this device; your purchase is untouched.
              </p>
              {openPortal.isError && (
                <p className="text-destructive text-xs">{(openPortal.error as Error).message}</p>
              )}
            </div>
          ) : (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (keyInput.trim()) activate.mutate(keyInput.trim())
                }}
              >
                <div className="space-y-1.5 flex-1 min-w-[260px]">
                  <Label className="text-xs">License key</Label>
                  <Input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" size="sm" disabled={!keyInput.trim() || activate.isPending}>
                  {activate.isPending ? 'Activating…' : 'Activate'}
                </Button>
              </form>
              {activate.isError && (
                <p className="text-destructive text-xs">{(activate.error as Error).message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Your key is in your purchase email and on the post-checkout page. Lost it?{' '}
                <a className="underline hover:text-foreground" href={`${siteUrl}/manage.html`} target="_blank" rel="noopener noreferrer">
                  Recover it on the website
                </a>
                .
              </p>
            </div>
          )}
        </section>

        {/* Upsell, only when not licensed */}
        {!licensed && (
          <section>
            <div className="rounded-3xl border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Sparkles className="size-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Go live for $19 a year</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    New free models the moment they exist, instead of on the 1st of the month. One key, every
                    device. Cancel anytime; the router stays free forever.
                  </p>
                </div>
              </div>
              <a
                href={`${siteUrl}/#pricing`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
              >
                <Button size="sm">
                  Go Premium
                  <ExternalLink />
                </Button>
              </a>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
