import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, Download, ShieldCheck } from 'lucide-react'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { FieldError } from '@/components/ui/field-error'
import { useI18n } from '@/i18n'
import { apiFetch, getToken, type ApiError } from '@/lib/api'
import { toast } from '@/lib/toast'
import type { AuthStatus } from '@/components/auth-gate'
import type { ApiKey } from '../../../../shared/types'

type ExportFormat = 'json' | 'env' | 'csv'

// Two-step flow: choose what to export, then re-authenticate to actually get it.
type Step = 'options' | 'password'

const FORMAT_OPTIONS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: 'json', label: 'JSON', ext: 'json' },
  { value: 'env', label: '.env', ext: 'env' },
  { value: 'csv', label: 'CSV', ext: 'csv' },
]

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

// #786: the desktop build has no user-set password to re-enter, and its server
// skips re-auth for local requests, so the password step is skipped here too.
// Only the Electron preload sets this flag: a browser reaching the same desktop
// server over LAN still walks through the step, and the server still checks it.
const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __FREEAPI_DESKTOP__?: boolean }).__FREEAPI_DESKTOP__ === true

async function downloadExport(format: ExportFormat, healthyOnly: boolean, password: string) {
  const token = getToken()
  const params = new URLSearchParams({ format })
  if (healthyOnly) params.set('healthy', 'true')
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (password) headers['x-reauth-password'] = password
  const res = await fetch(`${BASE}/api/keys/export?${params}`, { headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as ApiError
    err.status = res.status
    err.code = body.error?.type
    throw err
  }
  const blob = await res.blob()
  const ext = FORMAT_OPTIONS.find(f => f.value === format)?.ext ?? format
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `freellmapi-keys.${ext}`
  a.click()
  URL.revokeObjectURL(url)
}

export function ExportKeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const [format, setFormat] = useState<ExportFormat>('json')
  const [healthyOnly, setHealthyOnly] = useState(false)
  // The password is asked for in a second step, once the export is actually
  // requested — not up front. Nothing about picking a format or a filter needs
  // re-authentication, so the prompt only appears at the point it guards.
  //
  // KeysPage mounts this dialog only while open, so every open starts on the
  // options step with an empty field: no reset effect, and no way for a
  // reopened dialog to inherit the last password typed into it.
  const [step, setStep] = useState<Step>('options')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [needsOidcReauth, setNeedsOidcReauth] = useState(false)
  const [openedAtMs] = useState(() => Date.now())

  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ['auth-status'],
    queryFn: () => apiFetch('/api/auth/status'),
    staleTime: 30_000,
  })
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const isOidcPasswordless = !isDesktopApp
    && authStatus?.authSource === 'oidc'
    && authStatus?.hasLocalPassword === false
  const hasFreshOidcReauth = isOidcPasswordless
    && !needsOidcReauth
    && authStatus?.reauthenticatedUntilMs != null
    && authStatus.reauthenticatedUntilMs > openedAtMs
  const providerName = authStatus?.oidc?.providerName || 'SSO'

  async function startOidcReauth() {
    setExporting(true)
    setError(null)
    try {
      const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>('/api/auth/oidc/reauth/start', {
        method: 'POST',
        body: JSON.stringify({ returnPath: window.location.pathname }),
      })
      window.location.assign(authorizeUrl)
    } catch (err) {
      setError((err as Error).message)
      setExporting(false)
    }
  }

  // The server flags what the export will really write. Counting `!keyless`
  // here instead promised keys the export then dropped — a no-auth custom
  // endpoint is not a "keyless provider", so it was counted and skipped (#687).
  const exportableKeys = keys.filter(k => k.exportable)
  const exportCount = healthyOnly
    ? exportableKeys.filter(k => k.status === 'healthy').length
    : exportableKeys.length

  async function handleExport(e?: FormEvent) {
    e?.preventDefault()
    setExporting(true)
    setError(null)
    try {
      await downloadExport(format, healthyOnly, password)
      toast.success(t('keys.exportSuccess', { count: exportCount }))
      onOpenChange(false)
    } catch (err) {
      if ((err as ApiError).code === 'oidc_reauth_required') {
        setNeedsOidcReauth(true)
        setStep('password')
      }
      // A rejected password keeps the user on this step with the field cleared
      // and the reason shown inline — a toast alone would leave the dialog
      // looking unchanged and give no hint of what to correct.
      setError((err as Error).message)
      setPassword('')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.exportKeys')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {step === 'password' ? (
          isOidcPasswordless ? (
            <div className="space-y-5">
              <p className="text-xs text-muted-foreground">
                {t('auth.oidcReauthHint', { provider: providerName })}
              </p>
              {error && <FieldError error={error} />}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep('options')}
                  disabled={exporting}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="button" className="flex-1" disabled={exporting} onClick={startOidcReauth}>
                  <ShieldCheck className="size-3.5" />
                  {t('auth.reverifyWithSso', { provider: providerName })}
                </Button>
              </div>
            </div>
          ) : (
            <form className="space-y-5" onSubmit={handleExport}>
              <div className="space-y-2">
                <Label className="text-xs" htmlFor="export-password">{t('auth.password')}</Label>
                <Input
                  id="export-password"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  placeholder={t('auth.passwordPlaceholderLogin')}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  aria-invalid={!!error}
                />
                <FieldError error={error} />
              </div>

              <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <span>{t('keys.exportWillExport')}</span>
                <span className="font-medium text-foreground">
                  {exportCount} {exportCount === 1 ? t('keys.exportKey') : t('keys.exportKeys plural')}
                </span>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep('options')}
                  disabled={exporting}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" className="flex-1" disabled={exporting || !password}>
                  <Download className="size-3.5" />
                  {exporting ? t('keys.exporting') : t('keys.exportDownload')}
                </Button>
              </div>
            </form>
          )
        ) : (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label className="text-xs">{t('keys.exportFormat')}</Label>
            <div className="flex gap-2">
              {FORMAT_OPTIONS.map(opt => (
                <Button
                  key={opt.value}
                  type="button"
                  size="sm"
                  variant={format === opt.value ? 'default' : 'outline'}
                  onClick={() => setFormat(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label className="text-xs">{t('keys.exportHealthyOnly')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('keys.exportHealthyOnlyDesc')}
              </p>
            </div>
            <Switch
              size="sm"
              checked={healthyOnly}
              onCheckedChange={setHealthyOnly}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span>{t('keys.exportWillExport')}</span>
            <span className="font-medium text-foreground">
              {exportCount} {exportCount === 1 ? t('keys.exportKey') : t('keys.exportKeys plural')}
            </span>
          </div>

          <Button
            type="button"
            className="w-full"
            onClick={() => (isDesktopApp || hasFreshOidcReauth ? handleExport() : setStep('password'))}
            disabled={exportCount === 0 || exporting}
          >
            <Download className="size-3.5" />
            {exporting ? t('keys.exporting') : t('keys.exportDownload')}
          </Button>
          {(isDesktopApp || hasFreshOidcReauth) && error && <FieldError error={error} />}
        </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
