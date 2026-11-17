import { useState } from 'react'
import { ListPlus } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { invalidateSearchQueries } from '@/lib/search'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldError } from '@/components/ui/field-error'
import { isHttpUrl } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { DiscoverModelsDialog } from './discover-models-dialog'
import { GroupLabelField } from './group-label-field'

// Split a free-text model field on commas / newlines into a clean id list,
// dropping blanks and duplicates so one endpoint can take several models. (#281)
function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !seen.has(s) && seen.add(s))
}

// Asymmetric embedding models (NVIDIA Nemotron 3.5) reject a request that
// carries no input_type, so the operator names the side here.
//
// Three states, because "leave it alone" and "send no input_type" are
// different answers:
//   unset — not specified: send nothing, and keep whatever the model already
//           has on record. The default, and the safe one: re-submitting an
//           existing model (a rename, a family change) must not silently drop
//           the input_type that makes an asymmetric endpoint answer at all.
//   none — explicitly symmetric: send no input_type, and clear a stored
//           value. What every symmetric model (bge-m3, text-embedding-3-*) wants.
//   a side — send that input_type.
//
// 'unset' is a UI-only sentinel: it never reaches the API, which takes the
// field's absence as "no opinion".
const EMBEDDING_INPUT_TYPE_UNSET = 'unset'
const EMBEDDING_INPUT_TYPE_NONE = 'none'
const EMBEDDING_INPUT_TYPES = ['query', 'passage'] as const

// Always rendered inside the Add key dialog: no outer section chrome/heading.
// `onAdded` lets that dialog close (and surface a toast) once a custom model is
// saved.
export function CustomProviderSection({ onAdded }: { onAdded?: () => void } = {}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [customType, setCustomType] = useState<'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'search' | 'decision'>('chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [family, setFamily] = useState('')
  const [apiKey, setApiKey] = useState('')
  // Endpoint group (#1176); blank = the default Custom group.
  const [groupLabel, setGroupLabel] = useState('')
  // Chat models default tools on (modern OpenAI-compatible servers all emit tool
  // calls) and vision off; declare them here or flip them later per model. (#470)
  const [supportsTools, setSupportsTools] = useState(true)
  const [supportsVision, setSupportsVision] = useState(false)
  // "Fetch models" asks the endpoint itself what it serves instead of making the
  // user paste ids from a curl (#488).
  const [discoverOpen, setDiscoverOpen] = useState(false)
  // Which side of an ASYMMETRIC embedding model this endpoint serves. Nemotron
  // 3.5 keeps "query" and "passage" in different vector spaces and rejects a
  // request that carries no input_type with a 400. Symmetric models (bge-m3,
  // text-embedding-3-*) want no input_type at all.
  const [embeddingInputType, setEmbeddingInputType] = useState<string>(EMBEDDING_INPUT_TYPE_UNSET)

  const models = customType === 'chat' ? parseModelList(model) : [model.trim()].filter(Boolean)
  const multiple = customType === 'chat' && models.length > 1

  // Field-level validation: submit stays clickable and reveals what is
  // missing instead of being silently disabled.
  const [attempted, setAttempted] = useState(false)
  const baseUrlError = !baseUrl.trim()
    ? t('validation.required')
    : !isHttpUrl(baseUrl)
      ? `${t('validation.url')} (http://localhost:8080/v1)`
      : null
  const modelError = models.length === 0 ? t('validation.required') : null

  const { data: embeddingsData } = useQuery<{ families: { family: string }[] }>({
    queryKey: ['embeddings'],
    queryFn: () => apiFetch('/api/embeddings'),
  })

  const addCustom = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      invalidateSearchQueries(queryClient)
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
      queryClient.invalidateQueries({ queryKey: ['decision-models'] })
      setModel('')
      setDisplayName('')
      setFamily('')
      setEmbeddingInputType(EMBEDDING_INPUT_TYPE_UNSET)
      setSupportsTools(true)
      setSupportsVision(false)
      if (onAdded) {
        toast.success(t('keys.modelAdded'))
        onAdded()
      }
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (baseUrlError || modelError) {
      setAttempted(true)
      return
    }
    setAttempted(false)
    const common = {
      baseUrl,
      model: models[0],
      displayName: !multiple ? (displayName || undefined) : undefined,
      apiKey: apiKey || undefined,
    }
    if (customType === 'chat') {
      addCustom.mutate({
        path: '/api/keys/custom',
        body: {
          baseUrl,
          models,
          displayName: !multiple ? (displayName || undefined) : undefined,
          apiKey: apiKey || undefined,
          groupLabel: groupLabel.trim() || undefined,
          supportsTools,
          supportsVision,
        },
      })
      return
    }
    if (customType === 'embedding') {
      addCustom.mutate({
        path: '/api/embeddings/custom',
        body: {
          ...common,
          family: family || undefined,
          // Undefined leaves the model's stored input_type alone; null says
          // "this endpoint is symmetric" and clears it. The field is only sent
          // when the operator actually chose something.
          ...(embeddingInputType === EMBEDDING_INPUT_TYPE_UNSET
            ? {}
            : { inputType: embeddingInputType === EMBEDDING_INPUT_TYPE_NONE ? null : embeddingInputType }),
        },
      })
      return
    }
    addCustom.mutate({
      path: '/api/media/custom',
      body: { ...common, modality: customType },
    })
  }

  const modelPlaceholder = customType === 'chat'
    ? 'qwen3:4b\nllama3:8b'
    : customType === 'embedding'
      ? 'text-embedding-3-small'
      : customType === 'image'
        ? 'gpt-image-1'
        : customType === 'transcription'
          ? 'Systran/faster-whisper-large-v3'
          : customType === 'search'
            ? 'my-search'
            : customType === 'decision'
              ? 'my-decider'
              : 'gpt-4o-mini-tts'
  const addLabel = customType === 'chat'
    ? (multiple ? t('keys.addModels', { count: models.length }) : t('keys.addModel'))
    : customType === 'embedding'
      ? t('keys.addEmbeddingModel')
      : customType === 'image'
        ? t('keys.addImageModel')
        : customType === 'transcription'
          ? t('keys.addTranscriptionModel')
          : customType === 'search'
            ? t('keys.addSearchEngine')
            : customType === 'decision'
              ? t('keys.addDecisionModel')
              : t('keys.addAudioModel')
  // Search and decision endpoints speak a fixed wire contract rather than the
  // OpenAI shape, so say which one before the user points them at a server.
  const contractHint = customType === 'search'
    ? t('keys.customSearchHint')
    : customType === 'decision'
      ? t('keys.customDecisionHint')
      : null

  const form = (
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customType')}</Label>
          <Select value={customType} onValueChange={(v) => setCustomType(v as typeof customType)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* label prop drives the trigger's SelectValue text (Base UI falls
                  back to the raw value without it, showing "chat" instead of
                  the translated label — #837). */}
              <SelectItem value="chat" label={t('keys.customTypeChat')}>{t('keys.customTypeChat')}</SelectItem>
              <SelectItem value="embedding" label={t('keys.customTypeEmbedding')}>{t('keys.customTypeEmbedding')}</SelectItem>
              <SelectItem value="image" label={t('keys.customTypeImage')}>{t('keys.customTypeImage')}</SelectItem>
              <SelectItem value="audio" label={t('keys.customTypeAudio')}>{t('keys.customTypeAudio')}</SelectItem>
              <SelectItem value="transcription" label={t('keys.customTypeTranscription')}>{t('keys.customTypeTranscription')}</SelectItem>
              <SelectItem value="search" label={t('keys.customTypeSearch')}>{t('keys.customTypeSearch')}</SelectItem>
              <SelectItem value="decision" label={t('keys.customTypeDecision')}>{t('keys.customTypeDecision')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{t('keys.customBaseUrl')}</Label>
          <Input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            className="font-mono text-xs"
            aria-invalid={attempted && !!baseUrlError}
          />
          {attempted && <FieldError error={baseUrlError} />}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{customType === 'chat' ? t('keys.customModels') : t('keys.customModel')}</Label>
            {customType === 'chat' && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setDiscoverOpen(true)}
                disabled={!!baseUrlError}
              >
                <ListPlus data-icon="inline-start" />
                {t('keys.discoverModels')}
              </Button>
            )}
          </div>
          <Textarea
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={modelPlaceholder}
            rows={customType === 'chat' ? 2 : 1}
            className="w-[200px] font-mono text-xs"
            aria-invalid={attempted && !!modelError}
          />
          {attempted && <FieldError error={modelError} />}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customDisplayName')}</Label>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={multiple ? t('keys.customDisplayNamePerModel') : t('keys.customDisplayNameOptional')}
            disabled={multiple}
            className="w-[150px]"
          />
        </div>
        {customType === 'embedding' && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.customFamily')}</Label>
            <Input
              value={family}
              onChange={e => setFamily(e.target.value)}
              placeholder={embeddingsData?.families?.[0]?.family ?? t('keys.customFamilyPlaceholder')}
              className="w-[190px] font-mono text-xs"
            />
          </div>
        )}
        {customType === 'embedding' && (
          // Only asymmetric models need this, and only they can be told apart
          // from the symmetric ones by trying: an endpoint that refuses a
          // request without an input_type is the tell. The default is "not
          // specified", which leaves the model's stored choice alone.
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.customEmbeddingInputType')}</Label>
            <Select
              value={embeddingInputType}
              onValueChange={(v) => setEmbeddingInputType(v)}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMBEDDING_INPUT_TYPE_UNSET} label={t('keys.customEmbeddingInputTypeUnset')}>
                  {t('keys.customEmbeddingInputTypeUnset')}
                </SelectItem>
                <SelectItem value={EMBEDDING_INPUT_TYPE_NONE} label={t('keys.customEmbeddingInputTypeNone')}>
                  {t('keys.customEmbeddingInputTypeNone')}
                </SelectItem>
                {EMBEDDING_INPUT_TYPES.map(it => (
                  <SelectItem key={it} value={it} label={it}>{it}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {customType === 'chat' && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.customCapabilities')}</Label>
            <div className="flex h-9 items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs">
                <Switch size="sm" checked={supportsTools} onCheckedChange={setSupportsTools} />
                <span>{t('models.tools')}</span>
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <Switch size="sm" checked={supportsVision} onCheckedChange={setSupportsVision} />
                <span>{t('models.vision')}</span>
              </label>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customApiKey')}</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={t('keys.customDisplayNameOptional')}
            className="w-[150px] font-mono text-xs"
          />
        </div>
        {customType === 'chat' && (
          <GroupLabelField value={groupLabel} onChange={setGroupLabel} className="w-[150px]" showHint={false} />
        )}
        <Button type="submit" size="sm" disabled={addCustom.isPending}>
          {addCustom.isPending ? t('keys.addingCustom') : addLabel}
        </Button>
      </form>
  )

  const errorLine = addCustom.isError ? (
    <p className="text-destructive text-xs mt-2">{(addCustom.error as Error).message}</p>
  ) : null

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">{t('keys.addCustomDescription')}</p>
      {form}
      {contractHint && <p className="text-xs text-muted-foreground mt-2" data-testid="custom-contract-hint">{contractHint}</p>}
      {errorLine}
      {discoverOpen && (
        <DiscoverModelsDialog
          open={discoverOpen}
          onOpenChange={setDiscoverOpen}
          endpoint={{ baseUrl, apiKey: apiKey || undefined, groupLabel }}
          onRegistered={onAdded}
        />
      )}
    </div>
  )
}
