import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
  }
}

export interface ChatSessionSummary {
  id: number
  title: string
  selectedModel: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[]
}

interface StoredPlaygroundState {
  currentSessionId: number | null
  messages: ChatMessage[]
  input: string
  selectedModel: string
}

interface PlaygroundChatContextValue extends StoredPlaygroundState {
  loading: boolean
  setInput: (value: string) => void
  setSelectedModel: (value: string) => void
  sendMessage: () => Promise<void>
  newChat: () => void
  loadSession: (sessionId: number) => Promise<void>
}

const STORAGE_KEY = 'freellmapi.playground.currentChat'
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const PlaygroundChatContext = createContext<PlaygroundChatContextValue | null>(null)

function readStoredState(): StoredPlaygroundState {
  if (typeof window === 'undefined') {
    return { currentSessionId: null, messages: [], input: '', selectedModel: 'auto' }
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { currentSessionId: null, messages: [], input: '', selectedModel: 'auto' }
    const parsed = JSON.parse(raw) as Partial<StoredPlaygroundState>
    return {
      currentSessionId: parsed.currentSessionId ?? null,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      input: typeof parsed.input === 'string' ? parsed.input : '',
      selectedModel: typeof parsed.selectedModel === 'string' ? parsed.selectedModel : 'auto',
    }
  } catch {
    return { currentSessionId: null, messages: [], input: '', selectedModel: 'auto' }
  }
}

export function PlaygroundChatProvider({ children }: { children: ReactNode }) {
  const initialState = useRef<StoredPlaygroundState | null>(null)
  if (!initialState.current) initialState.current = readStoredState()

  const [currentSessionId, setCurrentSessionId] = useState<number | null>(initialState.current.currentSessionId)
  const [messages, setMessages] = useState<ChatMessage[]>(initialState.current.messages)
  const [input, setInput] = useState(initialState.current.input)
  const [selectedModel, setSelectedModel] = useState(initialState.current.selectedModel)
  const [loading, setLoading] = useState(false)
  const queryClient = useQueryClient()

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  useEffect(() => {
    const state: StoredPlaygroundState = { currentSessionId, messages, input, selectedModel }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [currentSessionId, messages, input, selectedModel])

  async function saveChat(nextMessages: ChatMessage[], sessionId = currentSessionId) {
    const saved = await apiFetch<ChatSessionDetail>('/api/chats', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        selectedModel,
        messages: nextMessages,
      }),
    })
    setCurrentSessionId(saved.id)
    queryClient.invalidateQueries({ queryKey: ['chats'] })
    return saved
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput('')
    setLoading(true)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers.Authorization = `Bearer ${keyData.apiKey}`

      const body: any = {
        messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
      }
      if (selectedModel !== 'auto') body.model = selectedModel

      const start = Date.now()
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        const failedMessages = [...nextMessages, {
          role: 'assistant' as const,
          content: `Error: ${err.error?.message ?? 'Unknown error'}`,
        }]
        setMessages(failedMessages)
        await saveChat(failedMessages)
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      const completedMessages = [...nextMessages, {
        role: 'assistant' as const,
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
        },
      }]
      setMessages(completedMessages)
      await saveChat(completedMessages)
    } catch (err: any) {
      const failedMessages = [...nextMessages, {
        role: 'assistant' as const,
        content: `Error: ${err.message}`,
      }]
      setMessages(failedMessages)
      await saveChat(failedMessages).catch(() => undefined)
    } finally {
      setLoading(false)
    }
  }

  function newChat() {
    setCurrentSessionId(null)
    setMessages([])
    setInput('')
  }

  async function loadSession(sessionId: number) {
    const session = await apiFetch<ChatSessionDetail>(`/api/chats/${sessionId}`)
    setCurrentSessionId(session.id)
    setMessages(session.messages)
    setSelectedModel(session.selectedModel || 'auto')
    setInput('')
  }

  const value = useMemo<PlaygroundChatContextValue>(() => ({
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
  }), [currentSessionId, messages, input, selectedModel, loading])

  return (
    <PlaygroundChatContext.Provider value={value}>
      {children}
    </PlaygroundChatContext.Provider>
  )
}

export function usePlaygroundChat() {
  const context = useContext(PlaygroundChatContext)
  if (!context) throw new Error('usePlaygroundChat must be used inside PlaygroundChatProvider')
  return context
}
