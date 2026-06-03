import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Markdown } from '@/components/markdown'
import { Menu, PanelRightClose, PanelRightOpen, MessageSquare, Trash2, Cpu, FileJson, Clock, ListFilter } from 'lucide-react'

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

interface Session {
  id: string
  title: string
  date: string
  messages: ChatMessage[]
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

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>('auto')
  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem('chat_sessions')
    return saved ? JSON.parse(saved) : []
  })
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)

  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false)
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false)

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('chat_sessions', JSON.stringify(sessions))
  }, [sessions])

  // Update current session messages when messages change
  useEffect(() => {
    if (messages.length > 0) {
      if (!currentSessionId) {
        const newId = Date.now().toString()
        setCurrentSessionId(newId)
        const title = messages[0].content.slice(0, 30) + (messages[0].content.length > 30 ? '...' : '')
        setSessions(prev => [{ id: newId, title, date: new Date().toISOString(), messages }, ...prev])
      } else {
        setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages } : s))
      }
    }
  }, [messages, currentSessionId])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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
  }, [messages, currentSessionId])

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
    setCurrentSessionId(null)
    inputRef.current?.focus()
  }

  const loadSession = (id: string) => {
    const session = sessions.find(s => s.id === id)
    if (session) {
      setMessages(session.messages)
      setCurrentSessionId(session.id)
      setLeftSidebarOpen(false)
    }
  }

  const deleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setSessions(prev => prev.filter(s => s.id !== id))
    if (currentSessionId === id) {
      setMessages([])
      setCurrentSessionId(null)
    }
  }

  const clearAllSessions = () => {
    setSessions([])
    setMessages([])
    setCurrentSessionId(null)
  }


  const activeModelLabel = selectedModel === 'auto'
    ? 'Auto (fallback chain)'
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  return (
    <div className="flex h-[calc(100vh-4rem)] -mx-4 md:-mx-6 -mt-6 md:-mt-8 overflow-hidden bg-background">

      {/* Left Sidebar (History) - Drawer on mobile, persistent on md+ */}
      {leftSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden" onClick={() => setLeftSidebarOpen(false)} />
      )}
      <div className={`fixed md:static inset-y-0 left-0 z-50 w-72 bg-card/70 backdrop-blur-md border-r border-border/80 transform transition-transform duration-300 ease-in-out flex flex-col ${leftSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} md:block`}>
        <div className="p-4 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <MessageSquare className="size-4" />
            <span>Chat History</span>
          </div>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setLeftSidebarOpen(false)}>
            <Menu className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {sessions.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-8">No history yet</div>
          ) : (
            sessions.map(s => (
              <div
                key={s.id}
                onClick={() => loadSession(s.id)}
                className={`group flex items-center justify-between p-3 rounded-2xl cursor-pointer transition-colors ${s.id === currentSessionId ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-muted-foreground'}`}
              >
                <div className="truncate text-sm flex-1">{s.title}</div>
                <Button variant="ghost" size="icon" className="size-6 opacity-0 group-hover:opacity-100 text-destructive" onClick={(e) => deleteSession(e, s.id)}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="p-4 border-t border-border/50">
          <Button variant="outline" className="w-full justify-center rounded-2xl text-sm" onClick={clearAllSessions}>
            Clear Session History
          </Button>
        </div>
      </div>

      {/* Center Canvas (Active Chat Feed) */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <div className="h-14 border-b border-border/80 bg-background/80 backdrop-blur-md flex items-center justify-between px-4 z-10 sticky top-0">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setLeftSidebarOpen(true)}>
              <Menu className="size-5" />
            </Button>
            <div className="font-medium text-sm truncate">{currentSessionId ? sessions.find(s => s.id === currentSessionId)?.title : 'New Chat'}</div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={selectedModel} onValueChange={(v) => setSelectedModel(v ?? 'auto')}>
              <SelectTrigger className="w-[140px] sm:w-[200px] h-9 text-xs rounded-2xl bg-muted/50 border-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (fallback chain)</SelectItem>
                {availableModels.map(m => (
                  <SelectItem key={m.modelDbId} value={m.modelId}>
                    <span className="flex items-center gap-2">
                      <span>{m.displayName}</span>
                      <span className="text-[10px] text-muted-foreground hidden sm:inline">{m.platform}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setRightSidebarOpen(!rightSidebarOpen)}>
              {rightSidebarOpen ? <PanelRightClose className="size-5" /> : <PanelRightOpen className="size-5" />}
            </Button>
          </div>
        </div>

        {/* MESSAGES WILL GO HERE */}
        <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-4 pb-32">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="space-y-4 max-w-sm">
                <div className="size-16 bg-primary/10 text-primary rounded-3xl flex items-center justify-center mx-auto">
                  <MessageSquare className="size-8" />
                </div>
                <h2 className="text-xl font-medium tracking-tight">How can I help you today?</h2>
                <p className="text-sm text-muted-foreground">
                  Using <span className="text-foreground font-medium">{activeModelLabel}</span>. Switch models in the selector above.
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] md:max-w-[80%] rounded-3xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-card/70 backdrop-blur-sm border border-border/80 rounded-bl-sm shadow-sm'}`}>
                    {msg.role === 'assistant' && msg.meta && (
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70 bg-transparent w-fit px-1 py-0.5">
                        <Cpu className="size-3 text-primary animate-pulse" />
                        <span>Routed via {msg.meta.platform} · {msg.meta.model}</span>
                        {msg.meta.fallbackAttempts ? (
                          <span className="text-destructive">({msg.meta.fallbackAttempts} fallback)</span>
                        ) : null}
                        <span className="opacity-50 ml-1">[{msg.meta.latency}ms]</span>
                      </div>
                    )}
                    {msg.role === 'assistant' ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-muted/50 prose-pre:border prose-pre:border-border/50 prose-pre:rounded-2xl">
                        <Markdown>{msg.content}</Markdown>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-card/70 backdrop-blur-sm border border-border/80 rounded-3xl rounded-bl-sm px-4 py-3 min-w-[200px]">
                     <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70 bg-transparent w-fit px-1 py-0.5">
                        <ListFilter className="size-3 text-primary animate-spin" />
                        <span>Evaluating routing path...</span>
                      </div>
                    <div className="flex gap-1.5 px-1 py-2">
                      <span className="size-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-2 rounded-full bg-primary/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Sticky Input Deck */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent pt-10 pb-4 px-4 md:px-8">
          <div className="max-w-3xl mx-auto bg-card/90 backdrop-blur-xl border border-border/80 rounded-3xl p-2 shadow-lg shadow-black/5 flex items-end gap-2 transition-all">
            <Button variant="ghost" size="icon" className="rounded-full shrink-0 h-10 w-10 text-muted-foreground hover:text-foreground mb-0.5" onClick={handleClear} disabled={messages.length === 0}>
              <Trash2 className="size-4" />
            </Button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              rows={1}
              className="flex-1 resize-none bg-transparent border-0 px-2 py-3 text-sm focus:outline-none focus:ring-0 min-h-[44px] max-h-[200px]"
              style={{ height: 'auto' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 200) + 'px'
              }}
            />
            <Button onClick={handleSend} disabled={loading || !input.trim()} size="icon" className="rounded-full h-10 w-10 shrink-0 mb-0.5 bg-primary text-primary-foreground shadow-sm hover:opacity-90">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4 -mt-0.5 ml-0.5"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
            </Button>
          </div>
          <div className="text-center mt-2 text-[10px] text-muted-foreground/60">
            LLMs can make mistakes. Verify important information.
          </div>
        </div>
      </div>

      {/* Right Sidebar (Context Memo & Artifacts) */}
      {rightSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden" onClick={() => setRightSidebarOpen(false)} />
      )}
      <div className={`fixed lg:static inset-y-0 right-0 z-50 w-80 bg-card/70 backdrop-blur-md border-l border-border/80 transform transition-transform duration-300 ease-in-out flex flex-col ${rightSidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'} lg:block`}>
        <div className="p-4 border-b border-border/50 flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <FileJson className="size-4 text-primary" />
            <span>Memo & Artifacts</span>
          </div>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setRightSidebarOpen(false)}>
            <PanelRightClose className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
           {messages.length === 0 ? (
             <div className="text-center space-y-3 mt-10">
               <div className="size-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                 <FileJson className="size-5 text-muted-foreground" />
               </div>
               <div className="text-sm text-muted-foreground px-4">
                 Code snippets, extracted JSON, and variables will appear here to keep context tidy.
               </div>
             </div>
           ) : (
             <div className="space-y-4">
               <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Session Info</div>
               <div className="bg-background rounded-2xl p-3 border border-border/50 shadow-sm text-sm space-y-2">
                 <div className="flex justify-between items-center">
                   <span className="text-muted-foreground flex items-center gap-1.5"><MessageSquare className="size-3"/> Messages</span>
                   <span className="font-mono">{messages.length}</span>
                 </div>
                 <div className="flex justify-between items-center">
                   <span className="text-muted-foreground flex items-center gap-1.5"><Cpu className="size-3"/> Primary Model</span>
                   <span className="font-mono text-xs">{selectedModel === 'auto' ? 'Auto' : selectedModel.split('/')[1] || selectedModel}</span>
                 </div>
                 <div className="flex justify-between items-center">
                   <span className="text-muted-foreground flex items-center gap-1.5"><Clock className="size-3"/> Started</span>
                   <span className="font-mono text-xs">{new Date(sessions.find(s => s.id === currentSessionId)?.date || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                 </div>
               </div>
             </div>
           )}
        </div>
      </div>
    </div>
  )
}
