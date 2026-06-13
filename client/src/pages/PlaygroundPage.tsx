import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { Copy, Pencil, Square } from 'lucide-react'

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

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (editingIndex != null && editRef.current) {
      editRef.current.focus()
      editRef.current.setSelectionRange(editRef.current.value.length, editRef.current.value.length)
    }
  }, [editingIndex])

  async function sendMessages(msgs: ChatMessage[]) {
    setMessages(msgs)
    setLoading(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: msgs.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

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
        setMessages([...msgs, {
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

      setMessages([...msgs, {
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
      if (err.name === 'AbortError') return
      setMessages([...msgs, {
        role: 'assistant',
        content: `Error: ${err.message}`,
      }])
    } finally {
      abortRef.current = null
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    await sendMessages([...messages, { role: 'user', content: text }])
  }

  function handleEditStart(index: number) {
    if (loading) return
    setEditingIndex(index)
    setEditText(messages[index].content)
  }

  function handleEditCancel() {
    setEditingIndex(null)
    setEditText('')
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleEditConfirm(index: number) {
    const text = editText.trim()
    if (!text) return
    setEditingIndex(null)
    const truncated = messages.slice(0, index)
    await sendMessages([...truncated, { role: 'user', content: text }])
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
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="Playground"
        description="Send a chat completion through the router and see which provider serves it."
        actions={
          <>
            <Select value={selectedModel} onValueChange={(v) => { const m = v ?? 'auto'; setSelectedModel(m); localStorage.setItem('playground.model', m) }}>
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
                {availableModels.length === 0 && (
                  // Models only appear once a platform has an enabled key. Without
                  // one, the list is just "Auto" and looks broken — say why. (#269)
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    No models yet. Add an API key on the Keys page to populate this list.
                  </div>
                )}
              </SelectContent>
            </Select>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear}>
                Clear
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
                <p className="text-base font-medium">Send a message to get started.</p>
                <p className="text-sm text-muted-foreground">
                  Using <span className="text-foreground">{activeModelLabel}</span>. Switch models in the selector above.
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`group relative max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted'
                    }`}
                  >
                    {editingIndex === i ? (
                      <textarea
                        ref={editRef}
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            handleEditConfirm(i)
                          }
                          if (e.key === 'Escape') {
                            handleEditCancel()
                          }
                        }}
                        className="w-full bg-transparent resize-none focus:outline-none"
                        rows={3}
                      />
                    ) : msg.role === 'assistant' ? (
                      <Markdown>{msg.content}</Markdown>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                    {msg.role === 'assistant' && msg.content && (
                      <CopyButton
                        text={msg.content}
                        label="Copy reply"
                        className="absolute right-1.5 top-1.5 size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      />
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
                  <div className="flex gap-1 mt-1 px-1">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(msg.content)
                        setCopiedIndex(i)
                        setTimeout(() => setCopiedIndex(null), 1500)
                      }}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Copy className="size-3" />
                      {copiedIndex === i ? 'Copied!' : 'Copy'}
                    </button>
                    {msg.role === 'user' && editingIndex !== i && (
                      <button
                        onClick={() => handleEditStart(i)}
                        disabled={loading}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Pencil className="size-3" />
                        Edit
                      </button>
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
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            {loading ? (
              <Button onClick={handleStop} variant="destructive" size="default" className="gap-1.5">
                <Square className="size-3.5 fill-current" />
                Stop
              </Button>
            ) : (
              <Button onClick={handleSend} disabled={!input.trim()} size="default">
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
