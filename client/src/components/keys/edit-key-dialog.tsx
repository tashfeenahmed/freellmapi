import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { X } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { PLATFORMS } from './shared'
import { GroupLabelField } from './group-label-field'
import { capUsage } from './cap-usage'

type UpdateBody = {
  label?: string
  key?: string
  monthlyRequestCap?: number
  monthlyTokenCap?: number
  groupLabel?: string
  proxyUrl?: string
}

/** Parse a budget-cap input: blank or 0 means unlimited (0); otherwise a
 *  non-negative integer. Anything else is invalid (null). */
function parseCap(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? n : null
}

/** Format a cap for the input: 0 (unlimited) shows as empty. */
function capToInput(cap: number | undefined): string {
  return cap && cap > 0 ? String(cap) : ''
}

/** A slim progress bar for one cap: neutral normally, amber at the 80% soft
 *  alert, red at the cap itself (the state where the server 429s). Mirrors
 *  the budget-alert thresholds so the dialog and the Logs page never
 *  disagree about "how close is this key to running out". */
function CapUsageBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const { t } = useI18n()
  const usage = capUsage(used, cap)
  if (!usage) return null
  const pctShown = Math.floor(usage.fraction * 100)
  const tone = usage.fraction >= 1
    ? 'bg-destructive'
    : usage.overWarning
      ? 'bg-amber-500'
      : 'bg-primary/60'
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className={usage.overWarning ? 'font-medium text-foreground' : undefined}>
          {t('keys.capUsagePercent', { used: used.toLocaleString(), cap: cap.toLocaleString(), pct: pctShown })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={pctShown}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pctShown)}%` }} />
      </div>
      {usage.overWarning && (
        <p className={`text-[11px] ${usage.fraction >= 1 ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`}>
          {usage.fraction >= 1 ? t('keys.capExhaustedWarning') : t('keys.capWarning80')}
        </p>
      )}
    </div>
  )
}

/** Edit the mutable parts of a key without deleting its stable endpoint
 *  identity. Changing the credential itself is deliberately explicit: the
 *  field starts empty because the API never sends plaintext secrets back. */
export function EditKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(apiKey.label)
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [accountId, setAccountId] = useState('')
  const [attempted, setAttempted] = useState(false)
  // Custom-endpoint group label (#1176): '' = the single legacy Custom group.
  const [groupLabel, setGroupLabel] = useState(apiKey.groupLabel ?? '')
  const isCustom = apiKey.platform === 'custom'
  // Monthly budget caps (#1158): editable here so the cap is settable from
  // the dashboard at all; it shipped API-only. Empty = unlimited.
  const [requestCap, setRequestCap] = useState(capToInput(apiKey.monthlyRequestCap))
  const [tokenCap, setTokenCap] = useState(capToInput(apiKey.monthlyTokenCap))
  // Per-key proxy (#590, #1526): shipped API-only. Like the credential, the
  // field starts empty and the saved proxy shows masked beside it, so the
  // masked password can never be submitted back over the real one.
  const [proxyUrl, setProxyUrl] = useState('')
  const [clearProxy, setClearProxy] = useState(false)

  const needsAccountId = apiKey.platform === 'cloudflare'
  // Every row takes a credential, including the anonymous row of a
  // key-optional platform (Kilo, OVH, AI Horde): a real key replaces the
  // sentinel there (#1331).
  const provider = PLATFORMS.find(p => p.value === apiKey.platform)
  const credential = useMemo(() => {
    if (!apiKeyValue.trim()) return ''
    if (needsAccountId) return accountId.trim() ? `${accountId.trim()}:${apiKeyValue.trim()}` : ''
    return apiKeyValue.trim()
  }, [accountId, apiKeyValue, needsAccountId])

  const credentialError = needsAccountId &&
    (accountId.trim() ? !apiKeyValue.trim() : Boolean(apiKeyValue.trim()))
    ? t('keys.editCredentialPartsRequired')
    : null
  const requestCapValue = parseCap(requestCap)
  const tokenCapValue = parseCap(tokenCap)
  const capError = requestCapValue === null || tokenCapValue === null
  const requestCapChanged = requestCapValue !== (apiKey.monthlyRequestCap || 0)
  const tokenCapChanged = tokenCapValue !== (apiKey.monthlyTokenCap || 0)
  const groupLabelChanged = isCustom && groupLabel.trim() !== (apiKey.groupLabel ?? '')
  const proxyChanged = Boolean(proxyUrl.trim()) || clearProxy
  const hasChanges = label !== apiKey.label || Boolean(credential) || requestCapChanged || tokenCapChanged || groupLabelChanged || proxyChanged

  const updateKey = useMutation({
    mutationFn: (body: UpdateBody) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      for (const key of ['keys', 'health']) queryClient.invalidateQueries({ queryKey: [key] })
      onOpenChange(false)
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (credentialError || capError) {
      setAttempted(true)
      return
    }

    const body: UpdateBody = {}
    if (label !== apiKey.label) body.label = label
    if (credential) body.key = credential
    if (requestCapChanged && requestCapValue !== null) body.monthlyRequestCap = requestCapValue
    if (tokenCapChanged && tokenCapValue !== null) body.monthlyTokenCap = tokenCapValue
    if (groupLabelChanged) body.groupLabel = groupLabel.trim()
    // '' clears the override; a typed URL replaces it (and wins over Remove).
    if (proxyChanged) body.proxyUrl = proxyUrl.trim()
    if (Object.keys(body).length > 0) updateKey.mutate(body)
    else onOpenChange(false)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-lg">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.editKey')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.platform')}</Label>
              <Input value={provider?.label ?? apiKey.platform} readOnly className="bg-muted/30" />
              <p className="text-[11px] text-muted-foreground">{t('keys.editPlatformLocked')}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="edit-key-label">{t('keys.label')}</Label>
              <Input
                id="edit-key-label"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder={t('keys.customDisplayNameOptional')}
              />
            </div>
          </div>

          {apiKey.baseUrl && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.customBaseUrl')}</Label>
              <Input value={apiKey.baseUrl} readOnly className="bg-muted/30 font-mono text-xs" />
            </div>
          )}

          {isCustom && <GroupLabelField value={groupLabel} onChange={setGroupLabel} />}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="edit-key-value">
                {needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}
              </Label>
              {!apiKey.keyless && (
                <code className="font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>
              )}
            </div>
            {needsAccountId && (
              <Input
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
                placeholder={t('keys.accountId')}
                className="font-mono text-xs"
                aria-invalid={attempted && Boolean(credentialError)}
              />
            )}
            <Input
              id="edit-key-value"
              type="password"
              autoComplete="new-password"
              value={apiKeyValue}
              onChange={e => setApiKeyValue(e.target.value)}
              placeholder={apiKey.keyless ? t('keys.keyOptionalPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
              className="font-mono text-xs"
              aria-invalid={attempted && Boolean(credentialError)}
            />
            {attempted && <FieldError error={credentialError} />}
            <p className="text-[11px] text-muted-foreground">
              {apiKey.keyless ? t('keys.keyOptionalHint') : t('keys.editCredentialHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs" htmlFor="edit-key-proxy">{t('keys.keyProxyLabel')}</Label>
              {apiKey.maskedProxyUrl && (
                <div className="flex min-w-0 items-center gap-2">
                  <code className={`truncate font-mono text-[11px] text-muted-foreground${clearProxy ? ' line-through' : ''}`}>
                    {apiKey.maskedProxyUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() => setClearProxy(c => !c)}
                    className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {clearProxy ? t('keys.keyProxyUndo') : t('common.remove')}
                  </button>
                </div>
              )}
            </div>
            <Input
              id="edit-key-proxy"
              autoComplete="off"
              spellCheck={false}
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder="socks5://user:pass@host:1080"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {clearProxy && !proxyUrl.trim() ? t('keys.keyProxyRemoved') : t('keys.keyProxyHint')}
            </p>
          </div>

          {/* Monthly budget (#1158) stays one collapsed line; it opens by
              default only when a cap is already set, so a cap is never hidden. */}
          <details className="group" open={Boolean(apiKey.monthlyRequestCap || apiKey.monthlyTokenCap) || undefined}>
            <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
              {apiKey.monthlyUsage
                ? t('keys.monthlyUsageLine', {
                    requests: apiKey.monthlyUsage.requests.toLocaleString(),
                    tokens: apiKey.monthlyUsage.tokens.toLocaleString(),
                  })
                : t('keys.monthlyRequestCapLabel')}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-request-cap">{t('keys.monthlyRequestCapLabel')}</Label>
                <Input
                  id="edit-key-request-cap"
                  inputMode="numeric"
                  value={requestCap}
                  onChange={e => setRequestCap(e.target.value)}
                  placeholder={t('keys.capUnlimitedPlaceholder')}
                  className="font-mono text-xs"
                  aria-invalid={attempted && requestCapValue === null}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="edit-key-token-cap">{t('keys.monthlyTokenCapLabel')}</Label>
                <Input
                  id="edit-key-token-cap"
                  inputMode="numeric"
                  value={tokenCap}
                  onChange={e => setTokenCap(e.target.value)}
                  placeholder={t('keys.capUnlimitedPlaceholder')}
                  className="font-mono text-xs"
                  aria-invalid={attempted && tokenCapValue === null}
                />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t('keys.capEditHint')}</p>
            {apiKey.monthlyUsage && (apiKey.monthlyRequestCap || apiKey.monthlyTokenCap) ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <CapUsageBar
                  label={t('keys.monthlyRequestCapLabel')}
                  used={apiKey.monthlyUsage.requests}
                  cap={apiKey.monthlyRequestCap ?? 0}
                />
                <CapUsageBar
                  label={t('keys.monthlyTokenCapLabel')}
                  used={apiKey.monthlyUsage.tokens}
                  cap={apiKey.monthlyTokenCap ?? 0}
                />
              </div>
            ) : null}
          </details>

          {updateKey.isError && (
            <p className="text-xs text-destructive">{(updateKey.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!hasChanges || updateKey.isPending}>
              {updateKey.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
