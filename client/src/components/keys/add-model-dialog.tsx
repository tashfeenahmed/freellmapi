import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import type { ApiKey } from '@freellmapi/shared/types'
import { PLATFORMS, CUSTOM_GROUP } from '@/components/keys/shared'

export interface AddModelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPlatform?: string
  /** Opened from a custom endpoint's key row: that key is preselected. */
  initialKeyId?: number
}

// Register a model by typing its id — for a relay whose /models list is
// incomplete, or a native provider row the catalog does not carry yet. Moved
// here from the Providers page when that page was folded into Keys.
export function AddModelDialog(props: AddModelDialogProps) {
  // Remount the form whenever the dialog (re)opens or its target changes, so
  // every field starts from the props — no effect-driven reset needed.
  const formKey = `${props.open ? 'open' : 'closed'}:${props.initialPlatform ?? ''}:${props.initialKeyId ?? ''}`
  return <AddModelForm key={formKey} {...props} />
}

interface CreateModelPayload {
  platform: string
  modelId: string
  displayName?: string
  supportsVision: boolean
  supportsTools: boolean
  keyId?: number
  contextWindow?: number
  rpmLimit?: number
  rpdLimit?: number
  tpmLimit?: number
  tpdLimit?: number
}

function AddModelForm({ open, onOpenChange, initialPlatform, initialKeyId }: AddModelDialogProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [platform, setPlatform] = useState<string>(initialPlatform ?? 'groq')
  const [keyId, setKeyId] = useState(initialKeyId != null ? String(initialKeyId) : '')
  const { data: keys = [] } = useQuery<ApiKey[]>({ queryKey: ['keys'], queryFn: () => apiFetch('/api/keys'), enabled: open && platform === 'custom' })
  const endpointKeys = keys.filter(key => key.platform === 'custom' && key.baseUrl)
  const selectedKey = endpointKeys.find(key => String(key.id) === keyId)
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


  const addModelMutation = useMutation({
    mutationFn: async (payload: CreateModelPayload) => {
      return apiFetch('/api/models', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      toast.success(t('keys.modelAddedSuccess'))
      onOpenChange(false)
    },
    onError: (err: unknown) => {
      toast.error((err instanceof Error ? err.message : null) || t('keys.modelAddFailed'))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitted(true)

    const trimmedModelId = modelId.trim()
    if (!trimmedModelId || !platform || (platform === 'custom' && !selectedKey)) return

    const payload: CreateModelPayload = {
      platform,
      modelId: trimmedModelId,
      displayName: displayName.trim() || undefined,
      supportsVision,
      supportsTools,
    }

    if (platform === 'custom') payload.keyId = selectedKey!.id

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
            <DialogTitle>{t('keys.addCustomModel')}</DialogTitle>
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
            <Label htmlFor="provider-platform-select">{t('keys.provider')}</Label>
            <select
              id="provider-platform-select"
              value={platform}
              onChange={(e) => { setPlatform(e.target.value); setKeyId('') }}
              className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {allProviders.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {platform === 'custom' && (
            <div className="space-y-1.5">
              <Label htmlFor="provider-endpoint-key">{t('keys.paneCustomEndpoint')}</Label>
              <select
                id="provider-endpoint-key"
                value={keyId}
                onChange={e => setKeyId(e.target.value)}
                aria-invalid={submitted && !selectedKey}
                className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1.5 text-sm"
              >
                <option value="">{t('keys.selectKey')}</option>
                {endpointKeys.map(key => <option key={key.id} value={String(key.id)}>{key.label || key.baseUrl} ({key.baseUrl})</option>)}
              </select>
              {endpointKeys.length === 0 && <Link to="/keys" className="text-sm text-primary underline">{t('keys.addCustom')}</Link>}
              {submitted && !selectedKey && <FieldError error={t('keys.selectKey')} />}
            </div>
          )}

          {/* Model ID */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-model-id">
              {t('keys.modelId')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="provider-model-id"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="e.g. meta-llama/llama-3.3-70b-instruct"
              aria-invalid={submitted && !modelId.trim()}
            />
            {submitted && !modelId.trim() && (
              <FieldError error={t('keys.modelIdRequired')} />
            )}
          </div>

          {/* Display Name */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-display-name">{t('keys.modelDisplayName')}</Label>
            <Input
              id="provider-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Llama 3.3 70B (Custom)"
            />
          </div>

          {/* Context Window */}
          <div className="space-y-1.5">
            <Label htmlFor="provider-context-window">{t('keys.modelContextWindow')}</Label>
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
              {t('keys.modelRateLimits')}
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
                  {t('keys.modelSupportsTools')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('keys.modelSupportsToolsHint')}
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
                  {t('keys.modelSupportsVision')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('keys.modelSupportsVisionHint')}
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
                t('keys.createModel')
              )}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
