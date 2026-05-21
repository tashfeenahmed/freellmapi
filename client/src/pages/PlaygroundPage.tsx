import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { getAppBaseUrl } from '@/lib/base-url'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { getActiveProjectId, renameProject } from '@/components/Sidebar'

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

function loadMessages(projectId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`freellmapi_messages_${projectId}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveMessages(projectId: string, messages: ChatMessage[]) {
  localStorage.setItem(`freellmapi_messages_${projectId}`, JSON.stringify(messages))
}

function loadSelectedModel(projectId: string): string {
  return localStorage.getItem(`freellmapi_project_model_${projectId}`) || 'auto'
}

function saveSelectedModel(projectId: string, model: string) {
  localStorage.setItem(`freellmapi_project_model_${projectId}`, model)
}

export default function PlaygroundPage() {
  const [projectId, setProjectId] = useState<string | null>(() => getActiveProjectId())
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const id = getActiveProjectId()
    return id ? loadMessages(id) : []
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const id = getActiveProjectId()
    return id ? loadSelectedModel(id) : 'auto'
  })
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const prevProjectIdRef = useRef<string | null>(null)

  const focusInput = () => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
  }

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  function autoNameProject(messages: ChatMessage[]) {
    if (!projectId) return
    const raw = localStorage.getItem('freellmapi_projects')
    if (!raw) return
    const projects = JSON.parse(raw)
    const project = projects.find((p: any) => p.id === projectId)
    if (!project) return
    const defaultPrefix = `Chat ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    if (project.name !== defaultPrefix) return

    const firstUser = messages.find(m => m.role === 'user')
    if (!firstUser) return
    const title = firstUser.content.replace(/["""''`*_~\[\]]/g, '').slice(0, 50).trim()
    if (!title) return
    renameProject(projectId, title)
  }

  useEffect(() => {
    function checkProject() {
      const id = getActiveProjectId()
      if (id && id !== prevProjectIdRef.current) {
        prevProjectIdRef.current = id
        setProjectId(id)
        setMessages(loadMessages(id))
        setSelectedModel(loadSelectedModel(id))
        setInput('')
        setLoading(false)
      }
    }
    checkProject()
    const interval = setInterval(checkProject, 200)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    if (!window.getSelection()?.toString()) {
      requestAnimationFrame(focusInput)
    }
  }, [messages, loading])

  useEffect(() => {
    const timer = setTimeout(focusInput, 50)
    return () => clearTimeout(timer)
  }, [projectId])

  useEffect(() => {
    if (!loading) focusInput()
  }, [loading])

  useEffect(() => {
    const onWindowFocus = () => focusInput()
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || loading || !projectId) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    saveMessages(projectId, newMessages)
    setInput('')
    setLoading(true)
    requestAnimationFrame(focusInput)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const start = Date.now()
      const res = await fetch(`${getAppBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        const errorMessages = [...newMessages, {
          role: 'assistant' as const,
          content: `Error: ${err.error?.message ?? 'Unknown error'}`,
        }]
        setMessages(errorMessages)
        saveMessages(projectId, errorMessages)
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      const assistantMessages = [...newMessages, {
        role: 'assistant' as const,
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      }]
      setMessages(assistantMessages)
      saveMessages(projectId, assistantMessages)
      if (newMessages.length === 1) autoNameProject(assistantMessages)
    } catch (err: any) {
      const errorMessages = [...newMessages, {
        role: 'assistant' as const,
        content: `Error: ${err.message}`,
      }]
      setMessages(errorMessages)
      saveMessages(projectId, errorMessages)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = () => {
    if (!projectId) return
    setMessages([])
    saveMessages(projectId, [])
    inputRef.current?.focus()
  }

  const handleModelChange = (value: string) => {
    setSelectedModel(value)
    if (projectId) saveSelectedModel(projectId, value)
  }

  const handleChatAreaClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('a, button, select, [role="combobox"], textarea')) return
    if (window.getSelection()?.toString()) return
    focusInput()
  }

  if (!projectId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Create a new chat to get started</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-screen bg-background">
      <div
        className="flex-1 overflow-y-auto min-h-0"
        onClick={handleChatAreaClick}
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-sm">
              <p className="text-sm text-muted-foreground">
                Send a message to start chatting
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`animate-message-fade-in ${msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}`}
              >
                <div className={`max-w-[80%] ${msg.role === 'user' ? '' : 'w-full'}`}>
                  {msg.role === 'user' ? (
                    <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="text-sm leading-relaxed">
                        <MarkdownRenderer content={msg.content} />
                      </div>
                      {msg.meta && (msg.meta.platform || msg.meta.model || msg.meta.latency != null) && (
                        <div className="flex items-center gap-2 mt-3 flex-wrap text-[11px] text-muted-foreground tabular-nums">
                          {msg.meta.platform && <span>{msg.meta.platform}</span>}
                          {msg.meta.model && <span className="font-mono">· {msg.meta.model}</span>}
                          {msg.meta.latency != null && <span>· {msg.meta.latency}ms</span>}
                          {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                            <span>· {msg.meta.fallbackAttempts} fallback{msg.meta.fallbackAttempts > 1 ? 's' : ''}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="animate-message-fade-in">
                <div className="flex gap-1.5 px-1">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border bg-background">
        <div className="max-w-3xl mx-auto px-4 py-3">
          <div className="flex items-end gap-2">
            <Select value={selectedModel} onValueChange={handleModelChange}>
              <SelectTrigger className="w-[140px] h-7 text-xs shrink-0" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" side="top" sideOffset={4}>
                <SelectItem value="auto">Auto</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message…"
              rows={1}
              className="flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring/50 min-h-[36px] max-h-[120px]"
              style={{ height: 'auto' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              }}
              readOnly={loading}
              aria-busy={loading}
            />
            <Button onClick={handleSend} disabled={loading || !input.trim()} size="sm">
              {loading ? '…' : 'Send'}
            </Button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <div />
            {messages.length > 0 && (
              <button
                onClick={handleClear}
                className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                Clear conversation
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
