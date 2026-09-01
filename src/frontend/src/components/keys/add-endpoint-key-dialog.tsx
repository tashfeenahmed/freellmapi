import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

// #702: a custom endpoint pools several credentials (#619), but the only way to
// register one was the model form, which insists on a model id. Once every model
// an endpoint serves is already registered there is nothing left to name there,
// so adding a second key needs its own door. Models belong to the endpoint, not
// to the key, so this form asks for the credential and nothing else.

export function AddEndpointKeyDialog({
  open,
  onOpenChange,
  baseUrl,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  baseUrl: string
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Mounted only while open, so every open starts with an empty field and no
  // reset effect is needed.
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch('/api/keys/custom', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, label: label.trim() || undefined }),
    }),
    onSuccess: () => {
      for (const key of ['keys', 'health']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('keys.keyAdded'))
      onOpenChange(false)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim()) return
    addKey.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.addKey')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.endpointKeysShareModels')}</p>
        <code className="mt-2 block truncate font-mono text-[11px] text-muted-foreground" title={baseUrl}>
          {baseUrl}
        </code>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="endpoint-key">{t('keys.customApiKey')}</Label>
            <Input
              id="endpoint-key"
              type="password"
              autoFocus
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t('keys.pasteKeyPlaceholder')}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="endpoint-key-label">{t('keys.label')}</Label>
            <Input
              id="endpoint-key-label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
            />
          </div>

          {addKey.isError && (
            <p className="text-xs text-destructive">{(addKey.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!apiKey.trim() || addKey.isPending}>
              {addKey.isPending ? t('keys.adding') : t('keys.addKey')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
