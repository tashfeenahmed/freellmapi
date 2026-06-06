import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { Tooltip } from '@/components/tooltip'

/** Subset of the /api/image-models response shape — only the fields consumed by ImageTab.
 *  Structural typing accepts the full API response (which has ~20 fields). */
interface ImageModel {
  slug: string
  shortName: string
  authorDisplayName: string
  outputModalities: string[]
  providerSlug: string
}

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
  }
}

interface GeneratedImage {
  url: string
  prompt: string
  model: string
  latency: number
  timestamp: number
  aspectRatio: string
  imageSize: string
  /** True while the request is in-flight; the card shows a spinner + elapsed time. */
  pending?: boolean
  /** Shown on the pending card when the request fails. */
  error?: string
}

type PlaygroundTab = 'chat' | 'image'

// ── Tab switcher ─────────────────────────────────────────────────────────────
function TabSwitcher({ active, onChange }: { active: PlaygroundTab; onChange: (t: PlaygroundTab) => void }) {
  const tab = (isActive: boolean) =>
    `px-3 py-1.5 text-xs rounded-lg transition-colors ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="inline-flex gap-1 rounded-xl border p-1">
      <button className={tab(active === 'chat')} onClick={() => onChange('chat')}>Chat</button>
      <button className={tab(active === 'image')} onClick={() => onChange('image')}>Image</button>
    </div>
  )
}

// ── Chat tab ─────────────────────────────────────────────────────────────────
function ChatTab({ keyData }: { keyData?: { apiKey: string } }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    inputRef.current?.focus()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

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
          content: `Error: ${err.error?.message ?? 'Unknown error'}`,
        }])
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      setMessages([...newMessages, {
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      }])
    } catch (err: any) {
      setMessages([...newMessages, {
        role: 'assistant',
        content: `Error: ${err.message}`,
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
    inputRef.current?.focus()
  }

  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  return (
    <div className="flex-1 flex flex-col rounded-3xl border bg-card overflow-hidden min-h-0">
      {/* Model selector + clear */}
      <div className="flex items-center gap-2 p-3 border-b">
        <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
          <SelectTrigger className="w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (fallback chain)</SelectItem>
            {availableModels.map(m => (
              <SelectItem key={m.modelDbId} value={m.modelId}>
                <span className="flex items-center gap-2">
                  <span>{m.displayName}</span>
                  <span className="text-xs text-muted-foreground">{m.platform}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {messages.length > 0 && (
          <Button variant="outline" size="sm" onClick={handleClear}>
            Clear
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center">
            <div className="space-y-2 max-w-sm">
              <p className="text-base font-medium">Send a message to get started.</p>
              <p className="text-sm text-muted-foreground">
                Using <span className="text-foreground">{activeModelLabel}</span>. Switch models in the selector above.
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <Markdown>{msg.content}</Markdown>
                  ) : (
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  )}
                  {msg.meta && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                      {msg.meta.platform && <span>{msg.meta.platform}</span>}
                      {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                      {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                      {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                        <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
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

      {/* Input */}
      <div className="border-t bg-background/50 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (⏎ to send, ⇧⏎ for newline)"
            rows={1}
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
            style={{ height: 'auto', overflow: 'hidden' }}
            onInput={e => autoResizeTextarea(e.target as HTMLTextAreaElement)}
          />
          <Button onClick={handleSend} disabled={loading || !input.trim()} size="default">
            {loading ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Image tab ────────────────────────────────────────────────────────────────
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const
const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const

/** Auto-resize a textarea to fit its content, up to maxHeight px. */
function autoResizeTextarea(el: HTMLTextAreaElement, maxHeight = 160) {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'
}

function ImageTab({ keyData }: { keyData?: { apiKey: string } }) {
  const [prompt, setPrompt] = useState('')
  const [, setTick] = useState(0)
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [aspectRatio, setAspectRatio] = useState<string>('1:1')
  const [imageSize, setImageSize] = useState<string>('1K')
  const [showAdvanced, setShowAdvanced] = useState(false)
  // Recraft
  const [style, setStyle] = useState('')
  const [strength, setStrength] = useState('')
  const [rgbColors, setRgbColors] = useState('')
  const [backgroundRgbColor, setBackgroundRgbColor] = useState('')
  // Sourceful
  const [scoringPrompt, setScoringPrompt] = useState('')
  const [backgroundMode, setBackgroundMode] = useState('original')
  const [backgroundHexColor, setBackgroundHexColor] = useState('')
  const [rgbConfigError, setRgbConfigError] = useState<string | null>(null)
  // Complex typed params (previously lumped in a generic JSON textarea)
  const [textLayout, setTextLayout] = useState('')
  const [fontInputs, setFontInputs] = useState('')
  const [superResRefs, setSuperResRefs] = useState('')
  const [scoringRubric, setScoringRubric] = useState('')
  // Raw JSON bidirectional view
  const [isRawJsonMode, setIsRawJsonMode] = useState(false)
  const [rawJsonText, setRawJsonText] = useState('')
  const [rawJsonError, setRawJsonError] = useState<string | null>(null)
  const [history, setHistory] = useState<GeneratedImage[]>([])
  // Input image for image-to-image generation
  const [inputImage, setInputImage] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [zoomLabel, setZoomLabel] = useState<string | null>(null)
  const zoomLabelTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panStart = useRef({ x: 0, y: 0 })
  const didDrag = useRef(false)
  const imageWrapperRef = useRef<HTMLDivElement>(null)
  // Ref for latest zoom scale so keyboard handler sees fresh value.
  const zoomScaleRef = useRef(zoomScale)
  zoomScaleRef.current = zoomScale
  const [expandedPrompts, setExpandedPrompts] = useState<Set<number>>(new Set())
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<number>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortControllers = useRef<Map<number, AbortController>>(new Map())

  const { data: imageModels = [] } = useQuery<ImageModel[]>({
    queryKey: ['image-models'],
    queryFn: () => apiFetch('/api/image-models'),
    staleTime: 10 * 60 * 1000,
  })

  useEffect(() => {
    if (imageModels.length > 0 && !selectedModel) {
      setSelectedModel(imageModels[0].slug)
    }
    // eslint-disable-next-line -- only run when models load
  }, [imageModels.length])

  // Clear recently-completed highlight after the animation duration.
  useEffect(() => {
    if (recentlyCompleted.size === 0) return
    const timeout = setTimeout(() => setRecentlyCompleted(new Set()), 1500)
    return () => clearTimeout(timeout)
  }, [recentlyCompleted])
  const completed = history.filter(img => !img.pending && !img.error)
  // Reset zoom/pan when navigating to a different image, and show hints briefly.
  useEffect(() => {
    setZoomScale(1)
    setPanOffset({ x: 0, y: 0 })
    setZoomLabel(null)
    if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
  }, [lightbox])
  useEffect(() => {
    if (lightbox === null) return
    // Lock body scroll while lightbox is open.
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'ArrowLeft' && lightbox > 0) setLightbox(lightbox - 1)
      else if (e.key === 'ArrowRight' && lightbox < completed.length - 1) setLightbox(lightbox + 1)
      else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        const next = Math.min(5, zoomScaleRef.current + 0.25)
        setZoomScale(next)
        setZoomLabel(`${Math.round(next * 100)}%`)
        if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
        zoomLabelTimeout.current = setTimeout(() => setZoomLabel(null), 1500)
      } else if (e.key === '-') {
        e.preventDefault()
        const next = Math.max(1, zoomScaleRef.current - 0.25)
        if (next === 1) setPanOffset({ x: 0, y: 0 })
        setZoomScale(next)
        setZoomLabel(`${Math.round(next * 100)}%`)
        if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
        zoomLabelTimeout.current = setTimeout(() => setZoomLabel(null), 1500)
      } else if (e.key === '0') {
        e.preventDefault()
        setZoomScale(1)
        setPanOffset({ x: 0, y: 0 })
        setZoomLabel('Fit')
        if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
        zoomLabelTimeout.current = setTimeout(() => setZoomLabel(null), 1500)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [lightbox, completed.length])

  // Abort all in-flight requests on unmount.
  useEffect(() => () => {
    abortControllers.current.forEach(c => c.abort())
    if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
  }, [])
  useEffect(() => {
    if (!history.some(img => img.pending)) {
      // No more pending requests — clean up expanded prompt state too.
      if (expandedPrompts.size > 0) setExpandedPrompts(new Set())
      return
    }
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [history])

  // ── Input image handlers ──────────────────────────────────────────
  const readFileAsDataUrl = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => setInputImage(reader.result as string)
    reader.onerror = () => setInputImage(null)
    reader.readAsDataURL(file)
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        readFileAsDataUrl(item.getAsFile()!)
        return
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer?.files?.[0]
    if (file?.type.startsWith('image/')) readFileAsDataUrl(file)
  }

  const handleGenerate = async () => {
    const text = prompt.trim()
    if (!text || !selectedModel) return

    const startTime = Date.now()
    const model = selectedModel
    const thisInputImage = inputImage // snapshot for this request
    const thisAspectRatio = aspectRatio
    const thisImageSize = imageSize

    // Push a pending placeholder immediately so the grid shows a spinner.
    const pendingEntry: GeneratedImage = {
      url: '',
      prompt: text,
      model,
      latency: 0,
      timestamp: startTime,
      aspectRatio: thisAspectRatio,
      imageSize: thisImageSize,
      pending: true,
    }
    setHistory(prev => [pendingEntry, ...prev].slice(0, 50))
    setPrompt('')
    setTimeout(() => inputRef.current?.focus(), 0)

    const controller = new AbortController()
    abortControllers.current.set(startTime, controller)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        model,
        messages: [{
          role: 'user',
          content: thisInputImage
            ? [
                { type: 'image_url', image_url: { url: thisInputImage } },
                { type: 'text', text },
              ]
            : text,
        }],
        modalities: activeModel?.outputModalities?.includes('text') ? ['image', 'text'] : ['image'],
      }

      if (aspectRatio !== '1:1' || imageSize !== '1K') {
        body.image_config = { aspect_ratio: aspectRatio, image_size: imageSize }
      }

      // ── Advanced image_config (Recraft / Sourceful / extra JSON) ────
      const imageConfig: Record<string, unknown> = body.image_config ? { ...body.image_config } : {}

      // Always include aspect_ratio + image_size when any advanced option is set
      const provider = activeModel?.providerSlug?.toLowerCase() ?? ''
      const advancedConfig = isRawJsonMode ? (() => { try { return JSON.parse(rawJsonText) ?? {} } catch { return {} } })() : computedImageConfig
      // Only include provider-specific fields when the provider matches
      const filteredAdvanced: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(advancedConfig)) {
        if (v == null || v === '') continue
        // Recraft-specific: style, strength, rgb_colors, background_rgb_color, text_layout
        if (['style', 'strength', 'rgb_colors', 'background_rgb_color', 'text_layout'].includes(k)) {
          if (provider === 'recraft') filteredAdvanced[k] = v
        // Sourceful-specific: scoring_prompt, scoring_rubric, font_inputs, super_resolution_references, background_mode, background_hex_color
        } else if (['scoring_prompt', 'scoring_rubric', 'font_inputs', 'super_resolution_references', 'background_mode', 'background_hex_color'].includes(k)) {
          if (provider === 'sourceful') filteredAdvanced[k] = v
        } else {
          filteredAdvanced[k] = v
        }
      }
      const hasAdvanced = Object.keys(filteredAdvanced).length > 0
      if (hasAdvanced && !imageConfig.aspect_ratio) {
        imageConfig.aspect_ratio = aspectRatio
        imageConfig.image_size = imageSize
      }
      Object.assign(imageConfig, filteredAdvanced)

      if (Object.keys(imageConfig).length > 0) {
        body.image_config = imageConfig
      }

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')

      // ── Non-streaming path ───────────────────────────────────────────
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const latency = Date.now() - startTime

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        const errMsg = err.error?.message ?? `HTTP ${res.status}`
        abortControllers.current.delete(startTime)
        setHistory(prev => prev.map(img =>
          img.timestamp === startTime ? { ...img, pending: false, error: errMsg } : img
        ))
        return
      }

      abortControllers.current.delete(startTime)
      const data = await res.json()
      const message = data.choices?.[0]?.message
      const images = message?.images ?? []

      if (images.length === 0) {
        // Some models return base64 in content instead of images array
        const content = message?.content ?? ''
        if (content.startsWith('data:image')) {
          setHistory(prev => prev.map(img =>
            img.timestamp === startTime ? { ...img, url: content, latency, pending: false } : img
          ))
          setRecentlyCompleted(prev => new Set(prev).add(startTime))
        } else {
          setHistory(prev => prev.map(img =>
            img.timestamp === startTime ? { ...img, pending: false, error: 'No image returned. The model may have returned text instead.' } : img
          ))
        }
        return
      }

      // Replace the pending placeholder with the first image,
      // then push additional images as new entries.
      let replaced = false
      for (const img of images) {
        const url = img.image_url?.url ?? img.url // fallback for providers omitting the image_url wrapper
        if (!url) continue
        if (!replaced) {
          setHistory(prev => prev.map(e =>
            e.timestamp === startTime ? { ...e, url, latency, pending: false } : e
          ))
          setRecentlyCompleted(prev => new Set(prev).add(startTime))
          replaced = true
        } else {
          const ts = Date.now()
          setHistory(prev => [{ url, prompt: text, model, latency, timestamp: ts, aspectRatio: thisAspectRatio, imageSize: thisImageSize }, ...prev].slice(0, 50))
          setRecentlyCompleted(prev => new Set(prev).add(ts))
        }
      }
    } catch (err: any) {
      abortControllers.current.delete(startTime)
      if (err.name === 'AbortError') {
        // Remove the pending placeholder entirely — nothing to show.
        setHistory(prev => prev.filter(img => img.timestamp !== startTime))
      } else {
        setHistory(prev => prev.map(img =>
          img.timestamp === startTime ? { ...img, pending: false, error: err.message ?? 'Unknown error' } : img
        ))
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleGenerate()
    }
  }

  // ── Computed image_config from individual fields ─────────────────────
  const computedImageConfig = useMemo(() => {
    const config: Record<string, unknown> = {}
    if (style.trim()) config.style = style.trim()
    const s = parseFloat(strength)
    if (strength.trim() && !isNaN(s) && s >= 0 && s <= 1) config.strength = s
    if (rgbColors.trim()) {
      try {
        const parsed = JSON.parse(`[${rgbColors}]`)
        if (Array.isArray(parsed) && parsed.every((c: unknown) => Array.isArray(c) && c.length === 3 && c.every((v: unknown) => typeof v === 'number'))) {
          config.rgb_colors = parsed
        }
      } catch { /* ignore */ }
    }
    if (backgroundRgbColor.trim()) {
      try {
        const parsed = JSON.parse(`[${backgroundRgbColor}]`)
        if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((v: unknown) => typeof v === 'number')) {
          config.background_rgb_color = parsed
        }
      } catch { /* ignore */ }
    }
    if (scoringPrompt.trim()) config.scoring_prompt = scoringPrompt.trim()
    const effectiveMode = backgroundHexColor.trim() && backgroundMode === 'original' ? 'solid' : backgroundMode
    if (effectiveMode !== 'original' || backgroundHexColor.trim()) {
      config.background_mode = effectiveMode
      if (effectiveMode === 'solid' && backgroundHexColor.trim()) config.background_hex_color = backgroundHexColor.trim()
    }
    try { if (textLayout.trim()) config.text_layout = JSON.parse(textLayout) } catch { /* ignore */ }
    try { if (fontInputs.trim()) config.font_inputs = JSON.parse(fontInputs) } catch { /* ignore */ }
    try { if (scoringRubric.trim()) config.scoring_rubric = JSON.parse(scoringRubric) } catch { /* ignore */ }
    const refs = superResRefs.split('\n').map(l => l.trim()).filter(Boolean)
    if (refs.length > 0) config.super_resolution_references = refs
    return config
  }, [style, strength, rgbColors, backgroundRgbColor, scoringPrompt, backgroundMode, backgroundHexColor, textLayout, fontInputs, scoringRubric, superResRefs])

  // ── Raw JSON blur handler (bidirectional sync: JSON → fields) ──────
  const handleRawJsonBlur = () => {
    try {
      const parsed = JSON.parse(rawJsonText)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setRawJsonError('Expected a JSON object, not an array')
        return
      }
      setRawJsonError(null)
      setStyle(parsed.style ?? '')
      setStrength(parsed.strength != null ? String(parsed.strength) : '')
      setRgbColors(Array.isArray(parsed.rgb_colors) ? parsed.rgb_colors.map((c: unknown) => Array.isArray(c) ? `[${(c as number[]).join(',')}]` : '').filter(Boolean).join(', ') : '')
      setBackgroundRgbColor(Array.isArray(parsed.background_rgb_color) ? JSON.stringify(parsed.background_rgb_color).replace(/[\[\]\s]/g, '') : '')
      setScoringPrompt(parsed.scoring_prompt ?? '')
      setBackgroundMode(['original', 'transparent', 'solid'].includes(parsed.background_mode) ? parsed.background_mode : 'original')
      setBackgroundHexColor(parsed.background_hex_color ?? '')
      setTextLayout(parsed.text_layout != null ? JSON.stringify(parsed.text_layout, null, 2) : '')
      setFontInputs(parsed.font_inputs != null ? JSON.stringify(parsed.font_inputs, null, 2) : '')
      setScoringRubric(parsed.scoring_rubric != null ? JSON.stringify(parsed.scoring_rubric, null, 2) : '')
      setSuperResRefs(Array.isArray(parsed.super_resolution_references) ? parsed.super_resolution_references.join('\n') : '')
    } catch (err: any) {
      setRawJsonError(`Invalid JSON: ${err.message}`)
    }
  }

  const activeModel = imageModels.find(m => m.slug === selectedModel)

  return (
    <div className="flex-1 flex flex-col rounded-3xl border bg-card overflow-hidden min-h-0 relative"
      onPaste={handlePaste}
      onDragOver={e => {
        e.preventDefault()
        if (e.dataTransfer?.types?.includes('Files')) setDragOver(true)
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={handleDrop}
    >
      {/* Drag overlay — covers the entire card */}
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-3xl bg-primary/10 border-2 border-dashed border-primary backdrop-blur-[1px]">
          <div className="text-center space-y-1">
            <span className="text-2xl">🖼</span>
            <p className="text-sm font-medium text-primary">Drop image here</p>
            <p className="text-xs text-muted-foreground">Use as reference for image-to-image generation</p>
          </div>
        </div>
      )}
      {/* Controls */}
      <div className="flex items-center gap-2 p-3 border-b flex-wrap">
        <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? '')}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select an image model…" />
          </SelectTrigger>
          <SelectContent>
            {imageModels.map(m => (
              <SelectItem key={m.slug} value={m.slug}>
                <span className="flex items-center gap-2">
                  <span>{m.shortName}</span>
                  <span className="text-xs text-muted-foreground">{m.authorDisplayName}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={aspectRatio} onValueChange={(v) => setAspectRatio(v ?? '1:1')}>
          <SelectTrigger className="w-[100px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ASPECT_RATIOS.map(r => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={imageSize} onValueChange={(v) => setImageSize(v ?? '1K')}>
          <SelectTrigger className="w-[90px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {IMAGE_SIZES.map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className={`text-xs px-2 py-1 rounded-lg transition-colors ${
            showAdvanced ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
        >
          ⚙ Advanced {showAdvanced ? '▾' : '▸'}
        </button>
        {history.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setHistory([])}>
            Clear
          </Button>
        )}
      </div>

      {/* Advanced options panel */}
      {showAdvanced && (
        <div className="border-b bg-muted/30 p-3 space-y-3 text-xs">
          {/* Toggle: structured vs raw JSON */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const next = !isRawJsonMode
                if (next) { setRawJsonText(JSON.stringify(computedImageConfig, null, 2)); setRawJsonError(null) }
                setIsRawJsonMode(next)
              }}
              className={`text-xs px-2 py-0.5 rounded-lg transition-colors ${
                isRawJsonMode ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              {'{ } Raw JSON'}
            </button>
          </div>

          {isRawJsonMode ? (
            /* ── Raw JSON view ───────────────────────────────── */
            <div className="space-y-1">
              <Textarea
                value={rawJsonText}
                onChange={e => { setRawJsonText(e.target.value); setRawJsonError(null) }}
                onBlur={handleRawJsonBlur}
                placeholder="{ &quot;style&quot;: &quot;Photorealism&quot;, ... }"
                className="min-h-[120px] text-xs font-mono"
              />
              {rawJsonError && (
                <p className="text-[10px] text-red-500">{rawJsonError}</p>
              )}
            </div>
          ) : (
            /* ── Structured inputs ──────────────────────────── */
            (() => {
              const provider = activeModel?.providerSlug?.toLowerCase() ?? ''
              return (
                <>
                  {/* ── Recraft ──────────────────────────── */}
                  {provider === 'recraft' && (
                    <div className="space-y-2">
                      <p className="font-medium text-muted-foreground uppercase tracking-wide">Recraft options</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">Style</span>
                          <Input value={style} onChange={e => setStyle(e.target.value)} placeholder="e.g. Photorealism" className="h-7 text-xs" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-muted-foreground">Strength (0–1)</span>
                          <Input value={strength} onChange={e => setStrength(e.target.value)} placeholder="0.2" className="h-7 text-xs" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-muted-foreground">RGB colors</span>
                          <Input
                            value={rgbColors}
                            onChange={e => { setRgbColors(e.target.value); setRgbConfigError(null) }}
                            onBlur={() => {
                              if (!rgbColors.trim()) { setRgbConfigError(null); return }
                              try {
                                const parsed = JSON.parse(`[${rgbColors}]`)
                                if (!Array.isArray(parsed) || !parsed.every((c: unknown) => Array.isArray(c) && c.length === 3 && c.every((v: unknown) => typeof v === 'number'))) {
                                  setRgbConfigError('Expected: [r,g,b], [r,g,b]')
                                } else { setRgbConfigError(null) }
                              } catch { setRgbConfigError('Invalid format') }
                            }}
                            placeholder="[255,0,0], [0,128,0]"
                            className="h-7 text-xs"
                          />
                          {rgbConfigError && <p className="text-[10px] text-red-500">{rgbConfigError}</p>}
                        </label>
                        <label className="space-y-1">
                          <span className="text-muted-foreground">BG RGB color</span>
                          <Input value={backgroundRgbColor} onChange={e => setBackgroundRgbColor(e.target.value)} placeholder="0,0,255" className="h-7 text-xs" />
                        </label>
                      </div>
                      <div className="space-y-1">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">text_layout (JSON)</span>
                          <Textarea value={textLayout} onChange={e => setTextLayout(e.target.value)} placeholder='[{"text": "Hello", "bbox": [[0.3,0.45],[0.6,0.45],[0.6,0.55],[0.3,0.55]]}]' className="min-h-[40px] text-xs font-mono" />
                        </label>
                      </div>
                    </div>
                  )}

                  {/* ── Sourceful ────────────────────────── */}
                  {provider === 'sourceful' && (
                    <div className="space-y-2">
                      <p className="font-medium text-muted-foreground uppercase tracking-wide">Sourceful options</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">Scoring prompt</span>
                          <Input value={scoringPrompt} onChange={e => setScoringPrompt(e.target.value)} placeholder="Prefer realistic materials…" className="h-7 text-xs" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-muted-foreground">Background mode</span>
                          <Select value={backgroundMode} onValueChange={(v) => setBackgroundMode(v ?? 'original')}>
                            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="original">Original</SelectItem>
                              <SelectItem value="transparent">Transparent</SelectItem>
                              <SelectItem value="solid">Solid color</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        {backgroundMode === 'solid' && (
                          <label className="space-y-1">
                            <span className="text-muted-foreground">BG hex color</span>
                            <Input value={backgroundHexColor} onChange={e => setBackgroundHexColor(e.target.value)} placeholder="#f6f1e8" className="h-7 text-xs" />
                          </label>
                        )}
                      </div>
                      <div className="space-y-1">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">font_inputs (JSON)</span>
                          <Textarea value={fontInputs} onChange={e => setFontInputs(e.target.value)} placeholder='[{"font_url": "https://...", "text": "Hello"}]' className="min-h-[40px] text-xs font-mono" />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                          <span className="text-muted-foreground">super_resolution_references</span>
                          <Textarea value={superResRefs} onChange={e => setSuperResRefs(e.target.value)} placeholder="https://example.com/ref1.jpg&#10;https://example.com/ref2.jpg" className="min-h-[44px] text-xs font-mono" />
                        </label>
                        <label className="space-y-1">
                          <span className="text-muted-foreground">scoring_rubric (JSON)</span>
                          <Textarea value={scoringRubric} onChange={e => setScoringRubric(e.target.value)} placeholder='[{"key": "lighting", "label": "Lighting", "description": "...", "weight": 1}]' className="min-h-[44px] text-xs font-mono" />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )
            })()
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {history.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center">
            <div className="space-y-2 max-w-sm">
              <p className="text-base font-medium">Describe an image to generate.</p>
              <p className="text-sm text-muted-foreground">
                {activeModel
                  ? <>Using <span className="text-foreground">{activeModel.shortName}</span>.</>
                  : 'Select a model above.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {history.map((img, i) => (
              img.pending ? (
<div key={img.timestamp} className="rounded-2xl border bg-muted/50 aspect-square flex flex-col items-center justify-center relative group p-4">
                  {/* Cancel button */}
                  <button
                    onClick={e => { e.stopPropagation(); abortControllers.current.get(img.timestamp)?.abort() }}
                    className="absolute top-2 right-2 w-7 h-7 rounded-full bg-muted-foreground/20 hover:bg-red-500/80 text-muted-foreground hover:text-white text-sm flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100 z-10"
                    aria-label="Cancel generation"
                    title="Cancel generation"
                  >
                    ×
                  </button>
                  {/* Spinner + status */}
                  <div className="flex flex-col items-center gap-1.5">
                    <div className="flex gap-1 justify-center">
                      <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <p className="text-xs text-muted-foreground">Generating…</p>
                    <p className="text-[10px] text-muted-foreground/50 tabular-nums">{Math.floor((Date.now() - img.timestamp) / 1000)}s elapsed</p>
                  </div>
                  {/* Prompt + model — collapsible */}
                  <div className="mt-auto w-full pt-3 border-t border-border/30">
                    <p
                      onClick={e => {
                        e.stopPropagation()
                        setExpandedPrompts(prev => {
                          const next = new Set(prev)
                          if (next.has(img.timestamp)) next.delete(img.timestamp)
                          else next.add(img.timestamp)
                          return next
                        })
                      }}
                      className={`text-[11px] text-muted-foreground/70 leading-relaxed cursor-pointer transition-colors hover:text-muted-foreground ${
                        expandedPrompts.has(img.timestamp) ? '' : 'line-clamp-2'
                      }`}
                      title={expandedPrompts.has(img.timestamp) ? 'Click to collapse' : 'Click to expand'}
                    >
                      {img.prompt}
                    </p>
                    <p className="text-[10px] text-muted-foreground/40 mt-1 tabular-nums">{img.model.split('/').pop()}</p>
                  </div>
                </div>
              ) : img.error ? (
<div key={img.timestamp} className="rounded-2xl border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 aspect-square flex items-center justify-center relative group">
                  {/* Dismiss button */}
                  <button
                    onClick={e => { e.stopPropagation(); setHistory(prev => prev.filter(h => h.timestamp !== img.timestamp)) }}
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-200/60 hover:bg-red-400/80 dark:bg-red-800/60 dark:hover:bg-red-700/80 text-red-700 dark:text-red-300 hover:text-white text-sm flex items-center justify-center transition-colors opacity-0 group-hover:opacity-100"
                    aria-label="Dismiss error"
                    title="Dismiss"
                  >
                    ×
                  </button>
                  <div className="text-center space-y-3 p-4">
                    <div className="space-y-1">
                      <p className="text-xs text-red-700 dark:text-red-400">{img.error}</p>
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{img.prompt}</p>
                      <p className="text-[10px] text-muted-foreground/40">{img.model.split('/').pop()}</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => {
                        setHistory(prev => prev.filter(h => h.timestamp !== img.timestamp))
                        setPrompt(img.prompt)
                        setSelectedModel(img.model)
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                    >
                      ↻ Retry
                    </Button>
                  </div>
                </div>
              ) : (
              <div key={img.timestamp} className={`rounded-2xl border overflow-hidden bg-card cursor-pointer transition-shadow ${
                  recentlyCompleted.has(img.timestamp) ? 'ring-2 ring-emerald-400/60 shadow-lg shadow-emerald-400/20' : ''
                }`} onClick={() => {
                // Find this image's index in the completed list for lightbox navigation.
                const idx = completed.findIndex(c => c.timestamp === img.timestamp)
                if (idx !== -1) setLightbox(idx)
              }}>
                <div className="aspect-square relative group">
                  <img
                    src={img.url}
                    alt={img.prompt}
                    className="w-full h-full object-contain bg-black/5"
                  />
                  <a
                    href={img.url}
                    download={`image-${i}.png`}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Button variant="secondary" size="sm" className="text-xs h-7">
                      ↓ Download
                    </Button>
                  </a>
                </div>
<div className="p-3 space-y-1">
<div className="flex items-start gap-1.5">
                    <p
                      onClick={e => {
                        e.stopPropagation()
                        setExpandedPrompts(prev => {
                          const next = new Set(prev)
                          if (next.has(img.timestamp)) next.delete(img.timestamp)
                          else next.add(img.timestamp)
                          return next
                        })
                      }}
                      className={`text-xs text-muted-foreground flex-1 cursor-pointer transition-colors hover:text-foreground ${
                        expandedPrompts.has(img.timestamp) ? '' : 'line-clamp-2'
                      }`}
                      title={expandedPrompts.has(img.timestamp) ? 'Click to collapse' : 'Click to expand'}
                    >
                      {img.prompt}
                    </p>
<Tooltip text="Copy prompt">
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          navigator.clipboard.writeText(img.prompt)
                          const btn = e.currentTarget
                          btn.textContent = '✓'
                          setTimeout(() => { btn.textContent = '📋' }, 1200)
                        }}
                        className="shrink-0 text-[11px] text-muted-foreground/40 hover:text-muted-foreground transition-colors leading-relaxed"
                        aria-label="Copy prompt"
                      >
                        📋
                      </button>
                    </Tooltip>
                  </div>
<div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 tabular-nums">
                    <span>{img.model.split('/').pop()}</span>
                    <span>· {img.latency} ms</span>
                    <span>· {img.aspectRatio}</span>
                    <span>· {img.imageSize}</span>
<Tooltip text="Use these settings">
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          setAspectRatio(img.aspectRatio)
                          setImageSize(img.imageSize)
                        }}
                        className="text-[10px] text-muted-foreground/30 hover:text-muted-foreground transition-colors cursor-pointer"
                        aria-label="Use these settings"
                      >
                        ⚙
                      </button>
                    </Tooltip>
                  </div>
                </div>
              </div>
            )))}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t bg-background/50 p-3">
        {/* Input image preview */}
        {inputImage && (
          <div className="mb-2 flex items-start gap-2">
            <div className="relative rounded-lg overflow-hidden border w-16 h-16 shrink-0">
              <img src={inputImage} alt="Input" className="w-full h-full object-cover" />
              <button
                onClick={() => setInputImage(null)}
                className="absolute top-0 right-0 w-4 h-4 bg-foreground/70 text-background rounded-bl text-[10px] leading-none flex items-center justify-center hover:bg-foreground"
                title="Remove input image"
              >
                ×
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">Input image — this will be used as a reference for image-to-image generation.</p>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) readFileAsDataUrl(f) }}
          />
          <Tooltip text="Upload an input image for image-to-image generation. You can also paste an image or drag & drop one onto the text area.">
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-2.5 text-xs shrink-0"
              onClick={() => fileInputRef.current?.click()}
            >
              +
            </Button>
          </Tooltip>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputImage ? 'Describe how to transform the image…' : 'Describe the image you want to generate…'}
            rows={1}
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
            style={{ height: 'auto', overflow: 'hidden' }}
            onInput={e => autoResizeTextarea(e.target as HTMLTextAreaElement)}
          />
          <Button onClick={handleGenerate} disabled={!prompt.trim() || !selectedModel} size="default">
            Generate
          </Button>
        </div>
      </div>

      {/* ── Lightbox ───────────────────────────────────────────────────── */}
      {lightbox !== null && (() => {
        const img = completed[lightbox]
        if (!img) return null
        return (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          {/* Close button */}
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl flex items-center justify-center transition-colors"
            aria-label="Close lightbox"
          >
            ×
          </button>

          {/* Keyboard hints */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 rounded-xl bg-black/50 backdrop-blur px-4 py-2 text-white/70 text-[11px] pointer-events-none">
            <span><kbd className="text-white/90">Esc</kbd> close</span>
            <span><kbd className="text-white/90">←</kbd> <kbd className="text-white/90">→</kbd> navigate</span>
            <span><kbd className="text-white/90">Click</kbd> zoom</span>
            <span><kbd className="text-white/90">Scroll</kbd> zoom</span>
            <span><kbd className="text-white/90">+</kbd> <kbd className="text-white/90">−</kbd> <kbd className="text-white/90">0</kbd> zoom</span>
            <span><kbd className="text-white/90">Drag</kbd> pan</span>
          </div>

          {/* Previous arrow */}
          {lightbox > 0 && (
            <button
              onClick={e => { e.stopPropagation(); setLightbox(lightbox - 1) }}
              className="absolute left-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl flex items-center justify-center transition-colors"
              aria-label="Previous image"
            >
              ‹
            </button>
          )}

          {/* Next arrow */}
          {lightbox < completed.length - 1 && (
            <button
              onClick={e => { e.stopPropagation(); setLightbox(lightbox + 1) }}
              className="absolute right-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl flex items-center justify-center transition-colors"
              aria-label="Next image"
            >
              ›
            </button>
          )}

          {/* Image */}
          <div
            ref={imageWrapperRef}
            className="overflow-hidden rounded-xl"
            onWheel={e => {
              e.stopPropagation()
              const delta = e.deltaY > 0 ? -0.25 : 0.25
              const next = Math.min(5, Math.max(1, zoomScale + delta))
              // Zoom toward cursor position.
              if (next === 1) {
                setPanOffset({ x: 0, y: 0 })
              } else {
                const rect = imageWrapperRef.current?.getBoundingClientRect()
                if (rect) {
                  const dx = e.clientX - rect.left - rect.width / 2
                  const dy = e.clientY - rect.top - rect.height / 2
                  const ratio = next / zoomScale
                  setPanOffset({
                    x: dx - (dx - panOffset.x) * ratio,
                    y: dy - (dy - panOffset.y) * ratio,
                  })
                }
              }
              setZoomScale(next)
              setZoomLabel(`${Math.round(next * 100)}%`)
              if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
              zoomLabelTimeout.current = setTimeout(() => setZoomLabel(null), 1500)
            }}
          >
          {/* Zoom level indicator */}
          {zoomLabel && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 rounded-xl bg-black/60 backdrop-blur px-3 py-1.5 text-white text-sm font-medium tabular-nums pointer-events-none">
              {zoomLabel}
            </div>
          )}
            <img
              src={img.url}
              alt={img.prompt}
              draggable={false}
              className={`max-w-[90vw] max-h-[85vh] rounded-xl select-none ${
                isPanning ? '' : 'transition-transform duration-200'
              } ${
                zoomScale > 1 ? 'cursor-grab' : 'cursor-zoom-in'
              } ${isPanning ? 'cursor-grabbing' : ''}`}
              style={{
                objectFit: zoomScale > 1 ? 'none' : 'contain',
                transform: `scale(${zoomScale}) translate(${panOffset.x / zoomScale}px, ${panOffset.y / zoomScale}px)`,
                transformOrigin: 'center center',
              }}
              onClick={e => {
                e.stopPropagation()
                // Don't toggle zoom if the user was dragging.
                if (didDrag.current) {
                  didDrag.current = false
                  return
                }
                if (zoomScale > 1) {
                  setZoomScale(1)
                  setPanOffset({ x: 0, y: 0 })
                  setZoomLabel('Fit')
                } else {
                  setZoomScale(2)
                  setZoomLabel('200%')
                }
                if (zoomLabelTimeout.current) clearTimeout(zoomLabelTimeout.current)
                zoomLabelTimeout.current = setTimeout(() => setZoomLabel(null), 1500)
              }}
              onMouseDown={e => {
                if (zoomScale <= 1) return
                e.preventDefault()
                didDrag.current = false
                setIsPanning(true)
                panStart.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y }
              }}
              onMouseMove={e => {
                if (!isPanning) return
                didDrag.current = true
                setPanOffset({
                  x: e.clientX - panStart.current.x,
                  y: e.clientY - panStart.current.y,
                })
              }}
              onMouseUp={() => setIsPanning(false)}
              onMouseLeave={() => setIsPanning(false)}
            />
          </div>

          {/* Info footer */}
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 rounded-xl bg-black/60 backdrop-blur px-4 py-2.5 text-white text-xs"
            onClick={e => e.stopPropagation()}
          >
<div className="max-w-sm">
              {/* Prompt — expand/collapse + copy */}
              <div className="flex items-start gap-1.5">
                <p
                  onClick={() => {
                    setExpandedPrompts(prev => {
                      const next = new Set(prev)
                      if (next.has(img.timestamp)) next.delete(img.timestamp)
                      else next.add(img.timestamp)
                      return next
                    })
                  }}
                  className={`text-xs leading-relaxed cursor-pointer transition-colors hover:text-white/90 ${
                    expandedPrompts.has(img.timestamp) ? '' : 'line-clamp-2'
                  }`}
                  title={expandedPrompts.has(img.timestamp) ? 'Click to collapse' : 'Click to expand'}
                >
                  {img.prompt}
                </p>
<Tooltip text="Copy prompt">
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      navigator.clipboard.writeText(img.prompt)
                      const btn = e.currentTarget
                      btn.textContent = '✓'
                      setTimeout(() => { btn.textContent = '📋' }, 1200)
                    }}
                    className="shrink-0 text-[10px] text-white/30 hover:text-white/80 transition-colors leading-relaxed"
                    aria-label="Copy prompt"
                  >
                    📋
                  </button>
                </Tooltip>
              </div>
              {/* Metadata + settings */}
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-white/50 tabular-nums text-[11px]">
                  {img.model.split('/').pop()} · {img.latency} ms · {img.aspectRatio} · {img.imageSize}
                </p>
<Tooltip text="Use these settings">
                  <button
                    onClick={() => {
                      setAspectRatio(img.aspectRatio)
                      setImageSize(img.imageSize)
                    }}
                    className="text-[11px] text-white/20 hover:text-white/70 transition-colors cursor-pointer"
                    aria-label="Use these settings"
                  >
                    ⚙
                  </button>
                </Tooltip>
              </div>
            </div>
            <span className="text-white/30">{lightbox + 1} / {completed.length}</span>
            <a
              href={img.url}
              download={`image-${img.timestamp}.png`}
              className="ml-2"
            >
              <Button variant="secondary" size="sm" className="text-xs h-7">
                ↓ Download
              </Button>
            </a>
          </div>
        </div>
      )})()}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function PlaygroundPage() {
  const [tab, setTab] = useState<PlaygroundTab>('chat')

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Playground"
        description={tab === 'chat'
          ? 'Send a chat completion through the router and see which provider serves it.'
          : 'Generate images with free text-to-image models via OpenRouter.'}
        actions={<TabSwitcher active={tab} onChange={setTab} />}
      />
      {tab === 'chat' ? <ChatTab keyData={keyData} /> : <ImageTab keyData={keyData} />}
    </div>
  )
}
