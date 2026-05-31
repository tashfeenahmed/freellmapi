import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, MessageSquarePlus } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { usePlaygroundChat } from '@/lib/playground-chat'
import type { ChatSessionSummary } from '@/lib/playground-chat'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'

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

function formatChatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PlaygroundPage() {
  const {
    currentSessionId,
    messages,
    input,
    selectedModel,
    loading,
    setInput,
    setSelectedModel,
    sendMessage,
    newChat,
    loadSession,
  } = usePlaygroundChat()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: chats = [], isLoading: historyLoading } = useQuery<ChatSessionSummary[]>({
    queryKey: ['chats'],
    queryFn: () => apiFetch('/api/chats'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleSend = async () => {
    await sendMessage()
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleNewChat = () => {
    newChat()
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const handleLoadSession = async (sessionId: number) => {
    await loadSession(sessionId)
    setTimeout(() => inputRef.current?.focus(), 0)
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
            <Button variant="outline" size="sm" onClick={handleNewChat}>
              <MessageSquarePlus className="size-4" />
              New chat
            </Button>
          </>
        }
      />

      <div className="flex-1 flex gap-4 min-h-0">
        <aside className="w-[280px] shrink-0 rounded-lg border bg-card overflow-hidden flex flex-col min-h-0">
          <div className="border-b px-4 py-3 flex items-center gap-2">
            <History className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">History</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {historyLoading ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">Loading history...</div>
            ) : chats.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">Saved chats will appear here.</div>
            ) : (
              <div className="space-y-1">
                {chats.map(chat => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => handleLoadSession(chat.id)}
                    className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                      chat.id === currentSessionId
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <div className="truncate text-sm font-medium">{chat.title}</div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                      <span>{formatChatDate(chat.updatedAt)}</span>
                      <span>{chat.messageCount} msgs</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <div className="flex-1 flex flex-col rounded-lg border bg-card overflow-hidden min-w-0 min-h-0">
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
                      <div className="whitespace-pre-wrap">{msg.content}</div>
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

          <div className="border-t bg-background/50 p-3">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
                rows={1}
                className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 min-h-[40px] max-h-[160px]"
                style={{ height: 'auto', overflow: 'hidden' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
                }}
              />
              <Button onClick={handleSend} disabled={loading || !input.trim()} size="default">
                {loading ? 'Sending...' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
