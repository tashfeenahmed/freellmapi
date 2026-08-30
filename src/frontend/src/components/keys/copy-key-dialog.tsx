import { useState, type FormEvent } from 'react'
import { Copy } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

// #786: the desktop build has no user-set password (its machine user's
// password is random and never shown), so the re-verification dialog would
// lock desktop users out of copying a full key. The desktop server skips
// re-auth (FREEAPI_DESKTOP) for local requests, so here we just hide the
// password field. Only the Electron preload sets this flag, so a browser
// reaching the same desktop server over LAN still gets the field — and the
// server still demands the password from it.
const isDesktopApp = typeof window !== 'undefined'
  && (window as Window & { __FREEAPI_DESKTOP__?: boolean }).__FREEAPI_DESKTOP__ === true

// #705: the list only ever shows a masked key, and the sole way to read one
// back was to export every key to a file. This narrows that to one key, behind
// the same password re-verification the export uses: a live session is not
// enough to turn a stored credential back into plaintext.

export function CopyKeyDialog({
  keyId,
  maskedKey,
  onOpenChange,
}: {
  keyId: number
  maskedKey: string
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  // Mounted only while open, so the field starts empty every time and the
  // password never outlives the dialog.
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Only set when the clipboard refused: the key is on screen for a manual
  // copy, and disappears again with the dialog.
  const [revealed, setRevealed] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { key } = await apiFetch<{ key: string }>(`/api/keys/${keyId}/reveal`, {
        method: 'POST',
        // The desktop server skips re-auth for this local request (#786); the
        // web build still needs it.
        headers: isDesktopApp ? undefined : { 'x-reauth-password': password },
      })
      // A plain-HTTP LAN origin has no Clipboard API at all, so this falls back
      // to execCommand rather than throwing (#734). If even that fails the key
      // has already been revealed — show it instead of discarding it, or the
      // password round trip was for nothing.
      if (!await copyText(key)) {
        setRevealed(key)
        setError(t('common.copyFailed'))
        return
      }
      toast.success(t('keys.copiedKey'))
      onOpenChange(false)
    } catch (err) {
      // A wrong password lands here; it is worth fixing in place rather than
      // behind a closed dialog.
      setError((err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.copyFullKey')}</DialogTitle>
        {/* select-all + break-all so the fallback key can be grabbed in one
            click and still fits the dialog. */}
        <code className="mt-2 block font-mono text-[11px] text-muted-foreground break-all select-all">
          {revealed ?? maskedKey}
        </code>

        <form onSubmit={submit} className="mt-4 space-y-4">
          {!isDesktopApp && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="reveal-password">{t('auth.password')}</Label>
              <Input
                id="reveal-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                aria-invalid={!!error}
              />
              <FieldError error={error} />
            </div>
          )}
          {isDesktopApp && error && <FieldError error={error} />}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={(!isDesktopApp && !password) || busy}>
              <Copy className="size-3.5" />
              {t('keys.copyKey')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
