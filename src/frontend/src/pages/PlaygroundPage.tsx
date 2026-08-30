import { useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, CircleAlert, FileText, Paperclip, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { buildModelOptions } from '@/lib/model-groups'
import type { Chain } from '@/components/chain-manager'
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
import { readChatStream } from '@/lib/playground-stream'
import { ConversationSidebar } from '@/components/playground/conversation-sidebar'
import { SettingsRail } from '@/components/playground/settings-rail'
import {
  readSampling,
  samplingRequestParams,
  writeSampling,
  type SamplingSettings,
} from '@/lib/playground-sampling'
import {
  SIDEBAR_OPEN_KEY,
  autoTitle,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  readActiveConversationId,
  toStoredMessages,
  updateConversation,
  writeActiveConversationId,
  type ChatMessage,
  type ConversationSummary,
  type FusionPanelEntry,
} from '@/lib/playground-conversations'
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

// ChatMessage / FusionPanelEntry now live in lib/playground-conversations.ts:
// the transcript is persisted, so its shape is shared with the storage layer
// rather than owned by this component.

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

// Thinking tokens, shown INSIDE the assistant bubble above the answer. Same
// visual language as FusionTrace (minimal font, muted, hanging rule, chevron
// toggle) and the same behaviour: open while it streams so you can watch the
// model work, auto-collapsing once the answer itself starts.
function ReasoningTrace({ text, answerStarted }: { text: string; answerStarted?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const touched = useRef(false)
  useEffect(() => {
    if (answerStarted && !touched.current) setOpen(false)
  }, [answerStarted])
  return (
    <div className="mb-2 text-[10px] leading-snug text-muted-foreground/80">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o) }}
        className="inline-flex items-center gap-1 font-mono hover:text-foreground transition-colors"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {open ? t('common.hide') : t('common.show')}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l border-border/60 pl-2.5 italic opacity-80">
          {text}
        </div>
      )}
    </div>
  )
}

// How close to the bottom of the transcript still counts as "reading the live
// answer", in pixels. Slack is needed either way — sub-pixel scroll positions
// mean an exact comparison never matches — and a couple of lines' worth of it
// keeps the follow from dropping out on a stray trackpad nudge.
const SCROLL_FOLLOW_SLACK = 40

/** localStorage key holding whether the right-hand settings rail is expanded. */
const SETTINGS_OPEN_KEY = 'playground.settingsOpen'

// Both rails plus the chat need room the small breakpoints do not have: three
// columns on a phone leave the transcript a sliver. So below lg a visit starts
// with the rails collapsed to their strips whatever a desktop session
// remembered — the toggles still work, the remembered choice just isn't
// restored until there is width for it.
function initialRailOpen(key: string): boolean {
  if (typeof window === 'undefined') return true
  if (!window.matchMedia('(min-width: 1024px)').matches) return false
  return localStorage.getItem(key) !== 'false'
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
  const updateSystemPrompt = (v: string) => {
    setSystemPrompt(v)
    localStorage.setItem('playground.systemPrompt', v)
  }
  // Sampling knobs (temperature / top_p / max_tokens), edited in the settings
  // rail. Every one is opt-in, so an untouched rail composes exactly the
  // request the Playground sent before they existed. Remembered in
  // localStorage, NOT on the conversation row — these are how YOU like to
  // drive the Playground, not part of a saved transcript.
  const [sampling, setSampling] = useState<SamplingSettings>(() => readSampling())
  const updateSampling = (next: SamplingSettings) => {
    setSampling(next)
    writeSampling(next)
  }
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem('playground.model') ?? 'auto',
  )
  // Files staged for the NEXT message: images already downscaled to a data URI,
  // text-like files already decoded. Cleared on send. (#325)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // Purely cosmetic: the composer row centres its buttons against a one-line
  // box, but pins them to the bottom once the textarea has grown, which is
  // where the eye expects them on a tall message.
  const [composerGrown, setComposerGrown] = useState(false)
  const [dragging, setDragging] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Whether the transcript should keep itself pinned to the bottom. Every model
  // streams now, so a message can grow for a minute straight — scrolling up to
  // re-read something must not be undone by the next token.
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  // Cancels the in-flight completion when the user clears the chat, sends
  // again, or navigates away mid-stream.
  const abortRef = useRef<AbortController | null>(null)

  // ---- Saved conversations -------------------------------------------------
  // The transcript lives on the server now. `conversationId` is the row this
  // page is writing to; null means "nothing sent yet", and no row exists until
  // the first message — a fresh visit still opens on an empty transcript.
  const queryClient = useQueryClient()
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => initialRailOpen(SIDEBAR_OPEN_KEY))
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => initialRailOpen(SETTINGS_OPEN_KEY))
  // Mirrors of state the async save paths read AFTER their closure was made:
  // a stream that started before the row existed still has to save into it.
  const conversationIdRef = useRef<number | null>(null)
  const titleRef = useRef('')
  // Memoised create, so two saves racing at the start of a conversation (a
  // fast first answer and a quick second question) cannot mint two rows.
  const createRef = useRef<Promise<number | null> | null>(null)

  const { data: conversations = [] } = useQuery<ConversationSummary[]>({
    queryKey: ['playground-conversations'],
    queryFn: listConversations,
  })
  const refreshConversations = () => {
    queryClient.invalidateQueries({ queryKey: ['playground-conversations'] })
  }

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  // Named fallback chains (#1021). Every custom chain is served as an
  // `auto:<name>` model — /v1/models lists them and the send path already
  // routes them — but the picker only ever offered 'auto', so the one place
  // you could try a chain you had just built was a curl command. The id is
  // derived exactly as the server derives it (routes/proxy.ts).
  const { data: chains = [] } = useQuery<Chain[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const chainOptions = chains
    .filter(c => c.type === 'custom')
    .map(c => ({
      value: `auto:${c.name.toLowerCase()}`,
      label: c.emoji ? `${c.emoji} ${c.name}` : c.name,
      sub: `auto:${c.name.toLowerCase()}`,
      isNew: false,
      platforms: [] as string[],
    }))

  // Unification is always on now (the on/off toggle was removed), so the picker
  // always collapses a model's providers into one option.
  const unifyOn = true

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
  // A chain (`auto:<name>`) is as server-picked as plain auto: the router
  // chooses a vision-capable member for an image request, so the hint would be
  // guesswork about a model that has not been picked yet.
  const modelBlindToImages = pendingImages.length > 0
    && selectedModel !== 'auto' && selectedModel !== 'fusion'
    && !selectedModel.startsWith('auto:')
    && !visionValues.has(selectedModel)

  // Follow the stream only while the reader is parked at the bottom. Judging
  // by direction (rather than position alone) keeps our own smooth-scroll
  // animation — which always travels downwards — from being mistaken for the
  // user taking over, whatever they used to scroll: wheel, keys, or the bar.
  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    lastScrollTopRef.current = el.scrollTop
    const onScroll = () => {
      const top = el.scrollTop
      const movedUp = top < lastScrollTopRef.current - 1
      lastScrollTopRef.current = top
      if (el.scrollHeight - top - el.clientHeight <= SCROLL_FOLLOW_SLACK) followRef.current = true
      else if (movedUp) followRef.current = false
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (followRef.current) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // A stream left running after the page goes away would keep calling
  // setMessages on an unmounted tree (and hold the socket open).
  useEffect(() => () => abortRef.current?.abort(), [])

  // Adopt a conversation the server just handed back as the one this page is
  // writing to, and remember it for the next reload.
  const adoptConversation = (id: number, title: string) => {
    conversationIdRef.current = id
    titleRef.current = title
    setConversationId(id)
    writeActiveConversationId(id)
  }

  // The id to save into, creating the row on the first message. Returns null
  // when the create failed — saving is best-effort, never something that costs
  // you the answer on screen.
  const conversationIdFor = (msgs: ChatMessage[]): Promise<number | null> => {
    if (conversationIdRef.current !== null) return Promise.resolve(conversationIdRef.current)
    if (!createRef.current) {
      createRef.current = createConversation({
        title: autoTitle(msgs),
        messages: toStoredMessages(msgs),
        model: selectedModel,
        systemPrompt: systemPrompt.trim() || null,
      })
        .then(created => {
          adoptConversation(created.id, created.title)
          refreshConversations()
          return created.id
        })
        .catch(err => {
          // Let the next completed exchange try again rather than wedging the
          // page on one bad request.
          createRef.current = null
          console.error('[playground] could not create the conversation', err)
          return null
        })
    }
    return createRef.current
  }

  // Save the whole conversation — transcript, title, model, system prompt — in
  // one PUT. Called when a response FINISHES (never per delta) and on
  // rename/clear. A failure is logged and dropped: the transcript on screen is
  // the source of truth, and the next exchange saves it again.
  const persistConversation = async (msgs: ChatMessage[]) => {
    const id = await conversationIdFor(msgs)
    if (id === null) return
    try {
      const saved = await updateConversation(id, {
        // Auto-title once, from the opening question; a rename makes the title
        // non-empty for good, so it is never recomputed over.
        title: titleRef.current || autoTitle(msgs),
        messages: toStoredMessages(msgs),
        model: selectedModel,
        systemPrompt: systemPrompt.trim() || null,
      })
      if (conversationIdRef.current === id) titleRef.current = saved.title
      refreshConversations()
    } catch (err) {
      console.error('[playground] could not save the conversation', err)
    }
  }

  // Drop everything tied to the current conversation. Shared by "new
  // conversation", "clear", and a stored id that no longer exists.
  const resetConversationState = () => {
    abortRef.current?.abort()
    abortRef.current = null
    conversationIdRef.current = null
    titleRef.current = ''
    createRef.current = null
    setConversationId(null)
    writeActiveConversationId(null)
    setMessages([])
    setAttachments([])
    followRef.current = true
  }

  // Save whatever is on screen before it goes away — leaving a conversation
  // mid-stream should keep the part that had already arrived. The last
  // completed exchange saved itself; this only ever adds to that.
  const flushCurrentConversation = () => {
    if (messages.length > 0) void persistConversation(messages)
  }

  // Switch to a saved conversation: transcript, model and system prompt all
  // come back, so you land exactly where you left it.
  const openConversation = async (id: number) => {
    abortRef.current?.abort()
    abortRef.current = null
    const conversation = await getConversation(id)
    createRef.current = null
    setMessages(conversation.messages)
    setAttachments([])
    pickModel(conversation.model ?? 'auto')
    updateSystemPrompt(conversation.systemPrompt ?? '')
    adoptConversation(conversation.id, conversation.title)
    followRef.current = true
    inputRef.current?.focus()
  }

  const handleSelectConversation = (id: number) => {
    if (id === conversationIdRef.current) return
    flushCurrentConversation()
    openConversation(id).catch(err => {
      console.error('[playground] could not open the conversation', err)
      toast.error(t('playgroundSessions.loadFailed'))
      refreshConversations()
    })
  }

  // "New conversation" and "Clear" are the same move now: bank the current
  // transcript, then start with a blank one. The old chat stays in the sidebar.
  const handleNewConversation = () => {
    flushCurrentConversation()
    resetConversationState()
    inputRef.current?.focus()
  }

  const handleRenameConversation = (id: number, title: string) => {
    // Title only: a rename must not race the transcript of an in-flight answer
    // away, which is exactly what re-sending messages here would risk.
    updateConversation(id, { title })
      .then(saved => {
        if (conversationIdRef.current === id) titleRef.current = saved.title
        refreshConversations()
      })
      .catch(err => {
        console.error('[playground] could not rename the conversation', err)
        toast.error(t('playgroundSessions.renameFailed'))
      })
  }

  const handleDeleteConversation = (id: number) => {
    deleteConversation(id)
      .then(() => {
        // Deleting the open one leaves the Playground on a blank slate, the
        // same state a first-ever visit gets.
        if (conversationIdRef.current === id) resetConversationState()
        refreshConversations()
      })
      .catch(err => {
        console.error('[playground] could not delete the conversation', err)
        toast.error(t('playgroundSessions.deleteFailed'))
      })
  }

  const toggleSidebar = () => {
    setSidebarOpen(open => {
      localStorage.setItem(SIDEBAR_OPEN_KEY, String(!open))
      return !open
    })
  }

  const toggleSettings = () => {
    setSettingsOpen(open => {
      localStorage.setItem(SETTINGS_OPEN_KEY, String(!open))
      return !open
    })
  }

  // Reopen whatever was on screen before the reload. A stored id that no longer
  // exists (deleted in another tab) just falls back to an empty transcript.
  useEffect(() => {
    const stored = readActiveConversationId()
    if (stored === null) return
    // The state it sets lands after the fetch resolves, not during this body —
    // restoring the session IS synchronising React with an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openConversation(stored).catch(() => writeActiveConversationId(null))
    // Mount only: this restores the session, it does not track later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

    // Returns the transcript it rendered, so the final flush can hand the
    // finished exchange straight to the save without rebuilding it.
    const flush = (streaming: boolean): ChatMessage[] => {
      const next: ChatMessage[] = [...baseMessages, {
        role: 'assistant',
        content: finalContent,
        meta: { latency: Date.now() - start, fusionPanel: [...panel], fusionJudge: judge, fusionStreaming: streaming },
      }]
      setMessages(next)
      return next
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
    // The exchange is complete: one save, here, never per delta.
    await persistConversation(flush(false))
  }

  // Read a plain (non-fusion) OpenAI chat stream, filling the assistant bubble
  // in place as content and reasoning deltas land. The routing metadata is
  // already known — it rides on the response headers, which arrive before the
  // first frame — so the only thing the stream adds is the latency, measured
  // to the last frame rather than to the first.
  const streamChat = async (
    stream: ReadableStream<Uint8Array>,
    baseMessages: ChatMessage[],
    start: number,
    routedVia: string | null,
    fallbackAttempts: string | null,
  ) => {
    const via = routedVia
      ? { platform: routedVia.split('/')[0], model: routedVia.split('/').slice(1).join('/') }
      : undefined
    let content = ''
    let reasoning = ''
    let failure: string | null = null

    // Returns the transcript it rendered, so the final flush can hand the
    // finished exchange straight to the save without rebuilding it.
    const flush = (streaming: boolean): ChatMessage[] => {
      const next: ChatMessage[] = [...baseMessages]
      // A stream that broke before the first token has nothing to show but the
      // error; one that broke halfway keeps what it managed to say.
      if (content || reasoning || failure === null) {
        next.push({
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(streaming ? { streaming: true } : {}),
          meta: {
            platform: via?.platform,
            model: via?.model,
            latency: Date.now() - start,
            fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
          },
        })
      }
      if (failure !== null) next.push({ role: 'assistant', isError: true, content: failure })
      setMessages(next)
      return next
    }

    await readChatStream(stream, {
      onDelta: text => { content += text; flush(true) },
      onReasoning: text => { reasoning += text; flush(true) },
      onError: message => { failure = message; flush(true) },
    })
    // The exchange is complete: one save, here, never per delta.
    await persistConversation(flush(false))
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
    // Your own message always brings the transcript back down, however far up
    // you had scrolled to read.
    followRef.current = true
    setMessages(newMessages)
    setInput('')
    setAttachments([])
    setLoading(true)
    inputRef.current?.focus()

    // The server row is born HERE — with the first message, not on arrival at
    // the page — so a visit that sends nothing leaves no trace in the sidebar.
    // Not awaited: the create runs alongside the completion, and every save
    // below waits on the same memoised promise.
    void conversationIdFor(newMessages)

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
        // Only the knobs switched on in the settings rail: temperature, top_p
        // and max_tokens, spelled as /v1/chat/completions parses them. An
        // untouched rail adds nothing at all, leaving provider defaults alone.
        ...samplingRequestParams(sampling),
      }
      if (selectedModel !== 'auto') body.model = selectedModel
      // Everything streams: fusion so you can watch the panel and the judge
      // arrive, every other model so the answer appears token by token instead
      // of after a silent minute.
      body.stream = true

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        // A refused request still ends an exchange, and the question that
        // provoked it is worth keeping — save the error bubble along with it.
        const failed: ChatMessage[] = [...newMessages, {
          role: 'assistant',
          isError: true,
          content: err.error?.message ?? t('common.unknownError'),
        }]
        setMessages(failed)
        await persistConversation(failed)
        return
      }

      if (isFusion && res.body) {
        await streamFusion(res.body, newMessages, start)
        return
      }

      // The proxy answers a streamed request with SSE or not at all (every
      // pre-commit failure is a non-2xx JSON body, already handled above), but
      // fall back to the buffered path rather than trusting that: a proxy in
      // front of us, or a future non-streaming route, can still hand back JSON.
      if (!isFusion && res.body && (res.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
        await streamChat(res.body, newMessages, start, routedVia, fallbackAttempts)
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

      const answered: ChatMessage[] = [...newMessages, {
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
      }]
      setMessages(answered)
      await persistConversation(answered)
    } catch (err: any) {
      // Clearing the chat (or leaving the page) aborts the stream on purpose —
      // that is not a failure to report, and the transcript it belonged to is
      // already gone.
      if (err?.name === 'AbortError') return
      const failed: ChatMessage[] = [...newMessages, {
        role: 'assistant',
        isError: true,
        content: err.message,
      }]
      setMessages(failed)
      await persistConversation(failed)
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

  // "Clear" no longer throws the chat away: it starts a NEW conversation and
  // leaves the old one in the sidebar. (resetConversationState stops an open
  // stream too, or its next frame would paste the half-finished answer back
  // into the empty transcript.)
  const handleClear = handleNewConversation

  // Searchable picker options: auto + fusion pinned at the top, then every model
  // ordered BY INTELLIGENCE — size tier first (Frontier→Small), then the catalog
  // rank within the tier, name as the final tiebreaker. (Raw intelligence_rank is
  // per-provider, not global, so tier-first matches the server's preset; #135.)
  const pickerOptions = [
    { value: 'auto', label: t('playground.autoModel'), sub: '', isNew: false, platforms: [] as string[] },
    { value: 'fusion', label: t('playground.fusionModel'), sub: '', isNew: false, platforms: [] as string[] },
    ...chainOptions,
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
    : selectedModel.startsWith('auto:')
    // A remembered chain whose name has since changed (or been deleted) has no
    // option left to read a label from; the raw id is still the truth.
    ? chainOptions.find(o => o.value === selectedModel)?.label ?? selectedModel
    : modelOptions.find(o => o.value === selectedModel)?.label ?? selectedModel

  return (
    // Three columns, edge to edge: conversations, the chat, the settings rail.
    // The page is a flex child of the shell's full-bleed container, so it is
    // exactly as tall as what the navbar leaves and nothing here scrolls except
    // the three panes that mean to. The transcript keeps its OWN scroll
    // container in the middle column — transcriptRef and the follow-the-stream
    // behaviour are untouched by the reshuffle.
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        open={sidebarOpen}
        onToggle={toggleSidebar}
        onNew={handleNewConversation}
        onSelect={handleSelectConversation}
        onRename={handleRenameConversation}
        onDelete={handleDeleteConversation}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The page header, reduced to a slim bar: the title, what is answering,
            and the one action that belongs to the transcript rather than to a
            rail. */}
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight">{t('playground.title')}</h1>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <span aria-hidden="true">· </span>{activeModelLabel}
          </span>
          {messages.length > 0 && (
            <Button variant="outline" size="sm" className="ms-auto" onClick={handleClear}>
              {t('playground.clear')}
            </Button>
          )}
        </div>

        <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto p-6 space-y-4">
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
                // Reasoning that arrives before the first answer token counts:
                // that IS the bubble's content for the moment.
                const showBubble = msg.role === 'user' || msg.content.length > 0 || !!msg.reasoning
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
                            <>
                              {msg.reasoning && (
                                <ReasoningTrace text={msg.reasoning} answerStarted={msg.content.length > 0} />
                              )}
                              <Markdown>{msg.content}</Markdown>
                            </>
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
                                  {/* Which provider served it is known from the
                                      response headers straight away; the timing
                                      only means something once the last frame
                                      has landed. */}
                                  {msg.meta.latency != null && !msg.streaming && <span>· {msg.meta.latency} ms</span>}
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
              {/* Typing dots until the reply starts materialising — which is
                  the first fusion frame, the first token of a stream, or the
                  whole message on the buffered path. */}
              {loading && messages[messages.length - 1]?.role === 'user' && (
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
          className={`bg-background/50 p-3 transition-colors ${dragging ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            addFiles([...e.dataTransfer.files])
          }}
        >
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
          <div className={`flex gap-2 ${composerGrown ? 'items-end' : 'items-center'}`}>
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
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
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
                const height = Math.min(el.scrollHeight, 160)
                el.style.height = height + 'px'
                setComposerGrown(height > 44)
              }}
            />
            <Button
              onClick={handleSend}
              disabled={loading || (!input.trim() && attachments.length === 0)}
              size="icon"
              className="rounded-full"
              aria-label={loading ? t('playground.sending') : t('playground.send')}
              title={loading ? t('playground.sending') : t('playground.send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Last column, and last in the DOM on purpose: the system prompt textarea
          it carries must never come before the composer's, which is what a
          plain `textarea` selector reaches for. */}
      <SettingsRail
        open={settingsOpen}
        onToggle={toggleSettings}
        modelValue={selectedModel}
        modelOptions={pickerOptions}
        onSelectModel={pickModel}
        noModels={availableModels.length === 0}
        systemPrompt={systemPrompt}
        onSystemPromptChange={updateSystemPrompt}
        sampling={sampling}
        onSamplingChange={updateSampling}
      />
    </div>
  )
}
