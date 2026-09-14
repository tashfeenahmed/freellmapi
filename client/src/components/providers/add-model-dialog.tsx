import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Sparkles, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { FieldError } from '@/components/ui/field-error'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { PLATFORMS, CUSTOM_GROUP } from '@/components/keys/shared'

export interface AddModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPlatform?: string
}

export function AddModelDialog({ open, onOpenChange, initialPlatform }: AddModelDialogProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [platform, setPlatform] = useState<string>(initialPlatform ?? 'groq')
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [rpmLimit, setRpmLimit] = useState('')
  const [rpdLimit, setRpdLimit] = useState('')
  const [tpmLimit, setTpmLimit] = useState('')
  const [tpdLimit, setTpdLimit] = useState('')
  const [supportsVision, setSupportsVision] = useState(false)
  const [supportsTools, setSupportsTools] = useState(true)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (open) {
      if (initialPlatform) setPlatform(initialPlatform)
      setModelId('')
      setDisplayName('')
      setContextWindow('')
      setRpmLimit('')
      setRpdLimit('')
      setTpmLimit('')
      setTpdLimit('')
      setSupportsVision(false)
      setSupportsTools(true)
      setSubmitted(false)
    }
  }, [open, initialPlatform])

  const addModelMutation = useMutation({
    mutationFn: async (payload: any) => {
      return apiFetch('/api/models', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success(t('providers.modelAddedSuccess'))
      onOpenChange(false)
    },
    onError: (err: any) => {
      toast.error(err?.message || t('providers.modelAddFailed'))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)

    const trimmedModelId = modelId.trim()
    if (!trimmedModelId || !platform) return

    const payload: any = {
      platform,
      modelId: trimmedModelId,
      displayName: displayName.trim() || undefined,
      supportsVision,
      supportsTools,
    }

    if (contextWindow) {
      const parsed = parseInt(contextWindow, 10)
      if (!isNaN(parsed) && parsed > 0) payload.contextWindow = parsed
    }
    if (rpmLimit) {
      const parsed = parseInt(rpmLimit, 10)
      if (!isNaN(parsed) && parsed > 0) payload.rpmLimit = parsed
    }
    if (rpdLimit) {
      const parsed = parseInt(rpdLimit, 10)
      if (!isNaN(parsed) && parsed > 0) payload.rpdLimit = parsed
    }
    if (tpmLimit) {
      const parsed = parseInt(tpmLimit, 10)
      if (!isNaN(parsed) && parsed > 0) payload.tpmLimit = parsed
    }
    if (tpdLimit) {
      const parsed = parseInt(tpdLimit, 10)
      if (!isNaN(parsed) && parsed > 0) payload.tpdLimit = parsed
    }

    addModelMutation.mutate(payload)
  }

  const allProviders = [...PLATFORMS, CUSTOM_GROUP]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            <DialogTitle>{t('providers.addCustomModel')}</DialogTitle>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Platform selection */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-platform-select">{t('providers.provider')}</Label>
            <select
              id="provider-platform-select"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {allProviders.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Model ID */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-model-id">
              {t('providers.modelId')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="provider-model-id"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. meta-llama/llama-3.3-70b-instruct"
              aria-invalid={submitted && !modelId.trim()}
            />
            {submitted && !modelId.trim() && (
              <FieldError error={t('providers.modelIdRequired')} />
            )}
          </div>

          {/* Display Name */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-display-name">{t('providers.displayName')}</Label>
            <Input
              id="provider-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Llama 3.3 70B (Custom)"
            />
          </div>

          {/* Context Window */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-context-window">{t('providers.contextWindow')}</Label>
            <Input
              id="provider-context-window"
              type="number"
              min="1"
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              placeholder="e.g. 128000"
            />
          </div>

          {/* Rate Limits Grid */}
          <div className="space-y-1.5 pt-1">
            <Label className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {t('providers.rateLimits')}
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="provider-rpm-limit" className="text-xs text-muted-foreground">{t('models.limitRpm')}</Label>
                <Input
                  id="provider-rpm-limit"
                  type="number"
                  min="1"
                  value={rpmLimit}
                  onChange={(e) => setRpmLimit(e.target.value)}
                  placeholder={t('models.limitRpmHint')}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="provider-rpd-limit" className="text-xs text-muted-foreground">{t('models.limitRpd')}</Label>
                <Input
                  id="provider-rpd-limit"
                  type="number"
                  min="1"
                  value={rpdLimit}
                  onChange={(e) => setRpdLimit(e.target.value)}
                  placeholder={t('models.limitRpdHint')}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="provider-tpm-limit" className="text-xs text-muted-foreground">{t('models.limitTpm')}</Label>
                <Input
                  id="provider-tpm-limit"
                  type="number"
                  min="1"
                  value={tpmLimit}
                  onChange={(e) => setTpmLimit(e.target.value)}
                  placeholder={t('models.limitTpmHint')}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label htmlFor="provider-tpd-limit" className="text-xs text-muted-foreground">{t('models.limitTpd')}</Label>
                <Input
                  id="provider-tpd-limit"
                  type="number"
                  min="1"
                  value={tpdLimit}
                  onChange={(e) => setTpdLimit(e.target.value)}
                  placeholder={t('models.limitTpdHint')}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>

          {/* Capabilities Switches */}
          <div className="flex flex-col gap-3 pt-2">
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/60 p-3">
              <div className="space-y-0.5">
                <Label htmlFor="switch-tools" className="text-sm font-medium">
                  {t('providers.supportsTools')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('providers.supportsToolsHint')}
                </p>
              </div>
              <Switch
                id="switch-tools"
                checked={supportsTools}
                onCheckedChange={setSupportsTools}
              />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-card/60 p-3">
              <div className="space-y-0.5">
                <Label htmlFor="switch-vision" className="text-sm font-medium">
                  {t('providers.supportsVision')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('providers.supportsVisionHint')}
                </p>
              </div>
              <Switch
                id="switch-vision"
                checked={supportsVision}
                onCheckedChange={setSupportsVision}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2 pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={addModelMutation.isPending}
            >
              {addModelMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {t('common.saving')}
                </>
              ) : (
                t('providers.createModel')
              )}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
