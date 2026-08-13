import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, CircleAlert, FileText, Paperclip, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ModelCombobox } from '@/components/model-combobox'
import { buildModelOptions } from '@/lib/model-groups'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'
import {
  ACCEPT_ATTRIBUTE,
  AttachmentError,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  attachmentImages,
  classifyFile,
  composeText,
  dataUrlBytes,
  formatBytes,
  readImageAttachment,
  readTextAttachment,
  toMessageContent,
  type Attachment,
} from '@/lib/attachments'
import { useI18n } from '@/i18n'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  canonicalId?: string
  displayName: string
  sizeLabel: string
  intelligenceRank: number
  supportsVision: boolean
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // Data URIs of the images attached to this turn: rendered as thumbnails in
  // the bubble and replayed as `image_url` parts on every follow-up request.
  images?: string[]
  // Request-level failure rendered as a distinct error bubble, not a fake
  // assistant reply.
  isError?: boolean
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
    // Fusion responses: the panel models (with their answers, for the
    // collapsible trace) and the judge that synthesized them (null when not
    // synthesized — single survivor / best_of). `fusionStreaming` is true while
    // panel/judge frames are still arriving.
    fusionPanel?: FusionPanelEntry[]
    fusionJudge?: { platform: string; model: string } | null
    fusionStreaming?: boolean
  }
}

interface FusionPanelEntry {
  platform: string
  model: string
  status?: 'ok' | 'failed'
  content?: string
  error?: string
}

// Render a fusion panel/judge entry as "platform/model", but avoid doubling
// the provider when the model id already carries it (e.g. openrouter/owl-alpha,
// groq/compound) — those would otherwise read "openrouter/openrouter/owl-alpha".
function fusionRouteLabel(p: { platform: string; model: string }): string {
  return p.model.startsWith(`${p.platform}/`) ? p.model : `${p.platform}/${p.model}`
}

// Collapsible, minimal-font trace shown OUTSIDE the main answer bubble: each
// panel model's raw answer as it streamed in, plus the judge that synthesized
// the final answer. Default-open so you can watch it work; collapse to tuck away.
function FusionTrace({ panel, judge, streaming, answerStarted }: {
  panel: FusionPanelEntry[]
  judge?: { platform: string; model: string } | null
  streaming?: boolean
  answerStarted?: boolean
}) {
  const { t } = useI18n()
  // Open while the panel streams in so you can watch it work; auto-collapse the
  // moment the final answer STARTS streaming (first token in the bubble), so it
  // tucks away as the answer takes over — unless the user manually toggled it.
  const [open, setOpen] = useState(true)
  const touched = useRef(false)
  useEffect(() => {
    if (answerStarted && !touched.current) setOpen(false)
  }, [answerStarted])
  return (
    <div className="w-full text-[10px] leading-snug text-muted-foreground/80">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o) }}
        className="inline-flex items-center gap-1 font-mono hover:text-foreground transition-colors"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('playground.fusionTrace', { count: panel.length })}{streaming ? ' …' : ''}
      </button>
      {open && (
        <div className="mt-1 space-y-2 border-l border-border/60 pl-2.5">
          {panel.map((p, i) => (
            <div key={i} className="space-y-0.5">
              <span className="font-mono font-medium">{fusionRouteLabel(p)}</span>
              {p.status === 'failed'
                ? <span className="ml-1.5 text-amber-600 dark:text-amber-400">{t('playground.fusionFailed')}{p.error ? `: ${p.error}` : ''}</span>
                : p.content
                  ? <div className="whitespace-pre-wrap opacity-80">{p.content}</div>
                  : <span className="ml-1.5 opacity-60">…</span>}
            </div>
          ))}
          {judge && (
            <div className="pt-1.5 border-t border-border/60">
              <span className="font-mono font-medium">{fusionRouteLabel(judge)}</span>
              <span className="ml-1.5 opacity-70">{t('playground.fusionJudgeSynth')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PlaygroundPage() {
  const { t } = useI18n()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  // Optional system prompt for this Playground session. Client-side only:
  // when set, it's prepended as a `system` message to the request. Persisted
  // to localStorage so it survives reloads.
  const [systemPrompt, setSystemPrompt] = useState<string>(
    () => localStorage.getItem('playground.systemPrompt') ?? '',
  )
  const [systemPromptOpen, setSystemPromptOpen] = useState<boolean>(
    () => !!localStorage.getItem('playground.systemPrompt'),
  )
  const updateSystemPrompt = (v: string) => {
    setSystemPrompt(v)
    localStorage.setItem('playground.systemPrompt', v)
  }
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem('playground.model') ?? 'auto',
  )
  // Files staged for the NEXT message: images already downscaled to a data URI,
  // text-like files already decoded. Cleared on send. (#325)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  // Unification is always on now (the on/off toggle was removed), so the picker
  // always collapses a model's providers into one option.
  const unifyOn = true

  const { data: combosData } = useQuery({
    queryKey: ['combos'],
    queryFn: () => apiFetch<{ combos: Array<{ name: string; strategy: string }> }>('/api/combos'),
  })
  const comboOptions = useMemo(
    () => (combosData?.combos ?? []).map(c => ({
      value: c.name,
      label: c.name,
      sub: c.strategy,
      isNew: true,
      platforms: [] as string[],
    })),
    [combosData],
  )

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  // Collapse the same model from multiple providers into one option (value =
  // canonical id, which the proxy resolves to the whole group).
  const modelOptions = buildModelOptions(availableModels, unifyOn)

  // Picker values that can accept images. A unified option counts as vision-
  // capable when ANY of its providers is, because routing picks a vision member
  // for image requests. Auto/Fusion are never flagged: the server picks the
  // model there (and hard-fails with a clear error if none can see).
  const visionValues = new Set(
    availableModels.filter(e => e.supportsVision).map(e => e.canonicalId ?? e.modelId),
  )
  const pendingImages = attachmentImages(attachments)
  const modelBlindToImages = pendingImages.length > 0
    && selectedModel !== 'auto' && selectedModel !== 'fusion'
    && !visionValues.has(selectedModel)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Read a fusion SSE stream, updating the assistant message in place as panel
  // answers + the judge arrive (additive `_fusion` frames) and the final answer
  // streams as content deltas.
  const streamFusion = async (stream: ReadableStream<Uint8Array>, baseMessages: ChatMessage[], start: number) => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let finalContent = ''
    const panel: FusionPanelEntry[] = []
    let judge: { platform: string; model: string } | null = null

    const flush = (streaming: boolean) => {
      setMessages([...baseMessages, {
        role: 'assistant',
        content: finalContent,
        meta: { latency: Date.now() - start, fusionPanel: [...panel], fusionJudge: judge, fusionStreaming: streaming },
      }])
    }
    flush(true)

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const tl = line.trim()
        if (!tl.startsWith('data:')) continue
        const d = tl.slice(5).trim()
        if (d === '[DONE]') continue
        let obj: any
        try { obj = JSON.parse(d) } catch { continue }
        if (obj._fusion) {
          if (obj._fusion.event === 'panel') {
            panel.push({ platform: obj._fusion.platform, model: obj._fusion.model, status: obj._fusion.status, content: obj._fusion.content, error: obj._fusion.error })
          } else if (obj._fusion.event === 'judge') {
            judge = { platform: obj._fusion.platform, model: obj._fusion.model }
          }
          flush(true)
        } else if (obj.error) {
          finalContent = `${t('playground.errorPrefix')} ${obj.error.message}`
          flush(true)
        } else if (obj.choices) {
          const delta = obj.choices[0]?.delta?.content
          if (delta) { finalContent += delta; flush(true) }
        }
      }
    }
    flush(false)
  }

  // Stage dropped/pasted/picked files. Every rejection is reported by name so a
  // silently missing attachment is impossible; accepted files are added in one
  // batch after the async reads settle.
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return
    const accepted: Attachment[] = []
    let imageBytes = pendingImages.reduce((sum, url) => sum + dataUrlBytes(url), 0)

    for (const file of files) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        toast.error(t('playground.attachTooMany', { count: MAX_ATTACHMENTS }))
        break
      }
      const kind = classifyFile(file)
      if (!kind) {
        toast.error(t('playground.attachUnsupported', { name: file.name }))
        continue
      }
      try {
        if (kind === 'image') {
          const dataUrl = await readImageAttachment(file)
          if (imageBytes + dataUrlBytes(dataUrl) > MAX_TOTAL_IMAGE_BYTES) {
            toast.error(t('playground.attachTooLarge', { name: file.name, max: formatBytes(MAX_TOTAL_IMAGE_BYTES) }))
            continue
          }
          imageBytes += dataUrlBytes(dataUrl)
          accepted.push({ id: `${Date.now()}-${accepted.length}-${file.name}`, kind, name: file.name, dataUrl })
        } else {
          const text = await readTextAttachment(file)
          accepted.push({ id: `${Date.now()}-${accepted.length}-${file.name}`, kind, name: file.name, text })
        }
      } catch (err) {
        const reason = err instanceof AttachmentError ? err.reason : 'unreadable'
        toast.error(reason === 'too-large'
          ? t('playground.attachTooLarge', {
              name: file.name,
              max: formatBytes(kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES),
            })
          : t('playground.attachFailed', { name: file.name }))
      }
    }
    if (accepted.length > 0) setAttachments(prev => [...prev, ...accepted])
  }

  const removeAttachment = (id: string) => setAttachments(prev => prev.filter(a => a.id !== id))

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || loading) return

    // Text-like files are inlined into the prompt; images ride along as data
    // URIs and become `image_url` parts in the request envelope below.
    const userMsg: ChatMessage = {
      role: 'user',
      content: composeText(text, attachments),
      ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setAttachments([])
    setLoading(true)
    inputRef.current?.focus()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const isFusion = selectedModel === 'fusion'
      const sysPrompt = systemPrompt.trim()
      const body: any = {
        messages: [
          ...(sysPrompt ? [{ role: 'system', content: sysPrompt }] : []),
          ...newMessages.map(m => ({ role: m.role, content: toMessageContent(m.content, m.images) })),
        ],
      }
      if (selectedModel !== 'auto') body.model = selectedModel
      // Fusion streams its panel + judge trace; ask for a stream so the
      // Playground can show the other models arriving before the final answer.
      if (isFusion) body.stream = true

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        setMessages([...newMessages, {
          role: 'assistant',
          isError: true,
          content: err.error?.message ?? t('common.unknownError'),
        }])
        return
      }

      if (isFusion && res.body) {
        await streamFusion(res.body, newMessages, start)
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      // Fusion responses carry a structured routing summary so we can show the
      // panel models that replied + the judge, rather than parsing the compact
      // X-Routed-Via string.
      const fusion = data._fusion as
        | { panel: { platform: string; model: string }[]; judge: { platform: string; model: string } | null }
        | undefined

      setMessages([...newMessages, {
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
          fusionPanel: fusion?.panel,
          fusionJudge: fusion?.judge,
        },
      }])
    } catch (err: any) {
      setMessages([...newMessages, {
        role: 'assistant',
        isError: true,
        content: err.message,
      }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = () => {
    setMessages([])
    setAttachments([])
    inputRef.current?.focus()
  }

  // Searchable picker options: auto + fusion pinned at the top, then every model
  // ordered BY INTELLIGENCE — size tier first (Frontier→Small), then the catalog
  // rank within the tier, name as the final tiebreaker. (Raw intelligence_rank is
  // per-provider, not global, so tier-first matches the server's preset; #135.)
  const pickerOptions = [
    { value: 'auto', label: t('playground.autoModel'), sub: '', isNew: false, platforms: [] as string[] },
    { value: 'fusion', label: t('playground.fusionModel'), sub: '', isNew: true, platforms: [] as string[] },
    ...comboOptions,
    ...modelOptions
      .slice()
      .sort((a, b) =>
        a.sizeTier - b.sizeTier ||
        a.intelligenceRank - b.intelligenceRank ||
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
      .map(o => ({
        value: o.value,
        label: o.label,
        sub: o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform,
        isNew: false,
        // Provider names for the multi-provider hover + search; empty when solo.
        platforms: o.providerCount > 1 ? o.platforms : [],
        // With images staged, flag (and dim) the models that can't read them.
        // Only a hint — sending anyway is allowed and the server decides.
        note: pendingImages.length > 0 && !visionValues.has(o.value)
          ? t('playground.noVisionBadge')
          : undefined,
      })),
  ]
  function pickModel(v: string) {
    setSelectedModel(v)
    localStorage.setItem('playground.model', v)
  }

  const activeModelLabel = selectedModel === 'auto'
    ? t('playground.autoModel')
    : selectedModel === 'fusion'
    ? t('playground.fusionModel')
    : comboOptions.find(c => c.value === selectedModel)?.label
    ?? modelOptions.find(o => o.value === selectedModel)?.label
    ?? selectedModel

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title={t('playground.title')}
        description={t('playground.description')}
        actions={
          <>
            <ModelCombobox
              value={selectedModel}
              options={pickerOptions}
              onSelect={pickModel}
              ariaLabel={t('playground.selectModel')}
              placeholder={t('playground.searchModels')}
              emptyText={t('playground.noModelsFound')}
              footer={
                availableModels.length === 0 ? (
                  // Models only appear once a platform has an enabled key. Without
                  // one, the list is just Auto/Fusion and looks broken — say why. (#269)
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('playground.noModels')}</div>
                ) : undefined
              }
            />
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear}>
                {t('playground.clear')}
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 flex flex-col rounded-3xl border bg-card overflow-hidden min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="space-y-2 max-w-sm">
                <p className="text-base font-medium">{t('playground.emptyTitle')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('playground.emptyDescription', { model: activeModelLabel })}
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => {
                const fusionPanel = msg.meta?.fusionPanel
                const okPanel = fusionPanel?.filter(p => p.status !== 'failed') ?? []
                // Skip an empty assistant bubble while the fusion trace is still
                // streaming in (no final answer yet) — the trace shows below.
                const showBubble = msg.role === 'user' || msg.content.length > 0
                return (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`flex flex-col gap-1 max-w-[80%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {showBubble && (
                        <div
                          className={`group relative rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                            msg.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : msg.isError
                                ? 'border border-destructive/25 bg-destructive/10 text-destructive'
                                : 'bg-muted'
                          }`}
                        >
                          {msg.images && msg.images.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              {msg.images.map((src, n) => (
                                <img key={n} src={src} alt="" className="size-20 rounded-lg object-cover" />
                              ))}
                            </div>
                          )}
                          {msg.isError ? (
                            <div className="flex items-start gap-2">
                              <CircleAlert className="mt-0.5 size-4 shrink-0" />
                              <div className="min-w-0">
                                <p className="font-medium">{t('playground.errorTitle')}</p>
                                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                              </div>
                            </div>
                          ) : msg.role === 'assistant' ? (
                            <Markdown>{msg.content}</Markdown>
                          ) : (
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                          )}
                          {msg.role === 'assistant' && !msg.isError && msg.content && (
                            <CopyButton
                              text={msg.content}
                              label={t('playground.copyReply')}
                              className="absolute right-1.5 top-1.5 size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                            />
                          )}
                          {msg.meta && (
                            <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                              {(fusionPanel || msg.meta.fusionStreaming) ? (
                                <>
                                  {okPanel.length > 0 && (
                                    <span>
                                      {t('playground.fusionPanel')}:{' '}
                                      <span className="font-mono">{okPanel.map(fusionRouteLabel).join(', ')}</span>
                                    </span>
                                  )}
                                  {msg.meta.fusionJudge && (
                                    <span>
                                      · {t('playground.fusionJudge')}:{' '}
                                      <span className="font-mono">{fusionRouteLabel(msg.meta.fusionJudge)}</span>
                                    </span>
                                  )}
                                  {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                                </>
                              ) : (
                                <>
                                  {msg.meta.platform && <span>{msg.meta.platform}</span>}
                                  {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                                  {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                                  {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                                    <span>· {msg.meta.fallbackAttempts} {msg.meta.fallbackAttempts > 1 ? t('playground.fallbacks') : t('playground.fallback')}</span>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {msg.role === 'assistant' && fusionPanel && fusionPanel.length > 0 && (
                        <FusionTrace
                          panel={fusionPanel}
                          judge={msg.meta?.fusionJudge}
                          streaming={msg.meta?.fusionStreaming}
                          answerStarted={msg.content.length > 0}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
              {loading && !messages[messages.length - 1]?.meta?.fusionStreaming && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div
          className={`border-t bg-background/50 p-3 transition-colors ${dragging ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            addFiles([...e.dataTransfer.files])
          }}
        >
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setSystemPromptOpen(o => !o)}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight className={`size-3.5 transition-transform ${systemPromptOpen ? 'rotate-90' : ''}`} />
              {t('playground.systemPromptLabel')}
              {systemPrompt.trim() && <span className="ml-1 size-1.5 rounded-full bg-primary/70" />}
            </button>
            {systemPromptOpen && (
              <textarea
                value={systemPrompt}
                onChange={e => updateSystemPrompt(e.target.value)}
                placeholder={t('playground.systemPromptPlaceholder')}
                rows={2}
                className="mt-1.5 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[44px] max-h-[160px]"
              />
            )}
          </div>
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map(a => (
                <div key={a.id} className="relative flex items-center gap-1.5 rounded-lg border bg-background py-1 pl-1.5 pr-6 text-xs">
                  {a.kind === 'image' && a.dataUrl
                    ? <img src={a.dataUrl} alt="" className="size-8 rounded object-cover" />
                    : <FileText className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="max-w-[140px] truncate">{a.name}</span>
                  <button
                    type="button"
                    aria-label={t('common.remove')}
                    title={t('common.remove')}
                    onClick={() => removeAttachment(a.id)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {modelBlindToImages && (
            <div className="mb-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('playground.visionWarning', { model: activeModelLabel })}</span>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={e => {
                addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              aria-label={t('playground.attach')}
              title={t('playground.attach')}
            >
              <Paperclip className="size-4" />
            </Button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={e => {
                // Screenshot straight from the clipboard; a normal text paste
                // carries no files and falls through untouched.
                const files = [...e.clipboardData.files]
                if (files.length === 0) return
                e.preventDefault()
                addFiles(files)
              }}
              placeholder={t('playground.inputPlaceholder')}
              rows={1}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            <Button onClick={handleSend} disabled={loading || (!input.trim() && attachments.length === 0)} size="default">
              {loading ? t('playground.sending') : t('playground.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
