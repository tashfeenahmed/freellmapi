import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { errorHint, streamChat, toChatTurns, type RouteInfo } from '@/lib/chat'
import {
  deleteConversation, listConversations, loadConversation, metaFrom, saveConversation, titleFrom, type StoredMessage,
} from '@/lib/conversations'
import { formatLatency } from '@/lib/telemetry'
import type { ProviderChoice } from '@/lib/capabilities'
import { IntelligenceCore } from './IntelligenceCore'
import { Markdown } from './Markdown'
import { CopyButton } from './CopyButton'
import { MicButton, VoicePanel } from './Voice'
import { useReadAloud, useVoiceInput } from '@/lib/useVoice'

// GLIXEL chat. The server enforces the persona and routes with free-only
// routing; this screen sends only the visible turns over the AI path the user
// chose, streams the answer, and shows the route the router actually used
// under each reply.

interface UiMessage extends StoredMessage {
  id: string
  streaming?: boolean
  route?: RouteInfo | null
  hint?: string | null
  code?: string | null
}

let seq = 0
const nextId = () => `m${++seq}`

function RouteChip({ message, provider }: { message: UiMessage; provider: string }) {
  const platform = message.route?.platform ?? message.meta?.platform
  const model = message.route?.model ?? message.meta?.model
  if (!platform || !model) return null
  const fallbacks = message.route?.fallbackAttempts ?? message.meta?.fallbackAttempts ?? 0
  const latency = message.meta?.latency ?? null
  return (
    <p className="text-[11px] font-mono text-glx-muted break-all" data-testid="route-chip">
      <span className="text-glx-cyan">via {platform}</span> · {model}
      {fallbacks > 0 && <span className="text-glx-warn"> · {fallbacks} fallback{fallbacks > 1 ? 's' : ''}</span>}
      {latency !== null && <> · {formatLatency(latency)}</>}
      <span className="sr-only"> · AI path {provider}</span>
      {message.route?.fallbackTrail && (
        <span className="block text-glx-muted/80">skipped: {message.route.fallbackTrail}</span>
      )}
    </p>
  )
}

function Bubble({ message, provider, onRetry, onUseFreeLLMAPI }: {
  message: UiMessage
  provider: string
  onRetry?: () => void
  onUseFreeLLMAPI?: () => void
}) {
  const mine = message.role === 'user'
  const showActions = !mine && !message.streaming
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-role={message.role} data-testid="message">
      <div
        className={[
          'min-w-0 px-3.5 py-2.5 text-[15px] leading-relaxed break-words',
          mine ? 'max-w-[88%] glx-bubble-user whitespace-pre-wrap' : message.isError ? 'max-w-[92%] glx-bubble-error' : 'w-full glx-bubble-assistant',
        ].join(' ')}
      >
        {mine || message.isError
          ? <span className="whitespace-pre-wrap" data-testid="message-text">{message.content}</span>
          : message.content
            ? <div data-testid="message-text"><Markdown text={message.content} /></div>
            : message.streaming ? <span className="glx-typing" aria-label="GLIXEL is answering">▍</span> : null}
        {message.isError && message.hint && <p className="mt-1.5 text-xs text-glx-text/80" data-testid="error-hint">{message.hint}</p>}
        {showActions && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {!message.isError && <RouteChip message={message} provider={provider} />}
            <div className="ml-auto flex gap-2">
              {!message.isError && message.content && <CopyButton text={message.content} label="Copy response" />}
              {message.isError && message.code === 'provider_unavailable' && onUseFreeLLMAPI && (
                <button type="button" className="glx-chip-button" onClick={onUseFreeLLMAPI}>Use FreeLLMAPI</button>
              )}
              {message.isError && onRetry && <button type="button" className="glx-chip-button" onClick={onRetry}>Retry</button>}
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

function History({ onOpen, onClose, currentId, onDeleted }: {
  onOpen: (id: number) => void
  onClose: () => void
  currentId: number | null
  onDeleted: (id: number) => void
}) {
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['glixel', 'conversations'], queryFn: listConversations })
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  async function confirmDelete(id: number) {
    setBusy(true)
    setFailed(null)
    try {
      await deleteConversation(id)
      onDeleted(id)
      await queryClient.invalidateQueries({ queryKey: ['glixel', 'conversations'] })
    } catch {
      setFailed('That conversation could not be deleted. Nothing was removed.')
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-glx-void/95 backdrop-blur-sm" role="dialog" aria-label="Conversation history">
      <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 border-b border-glx-line">
        <h2 className="glx-label">History</h2>
        <button type="button" className="glx-link text-sm" onClick={onClose}>Close</button>
      </div>
      <p className="px-4 py-2 text-[11px] text-glx-muted">Stored on your FreeLLMAPI server and shared with the dashboard Playground.</p>
      {failed && <p className="px-4 pb-2 text-xs text-glx-warn" role="alert">{failed}</p>}
      <ul className="flex-1 overflow-y-auto px-4 divide-y divide-glx-line" data-testid="history">
        {isPending && <li className="py-3 text-sm text-glx-muted">Loading…</li>}
        {isError && (
          <li className="py-3 text-sm text-glx-warn">
            Could not load history. <button type="button" className="glx-link" onClick={() => void refetch()}>Try again</button>
          </li>
        )}
        {data?.length === 0 && <li className="py-3 text-sm text-glx-muted">No conversations yet.</li>}
        {data?.map(c => (
          <li key={c.id} className="py-3">
            {confirming === c.id ? (
              <div className="space-y-2" data-testid="confirm-delete">
                <p className="text-sm">Delete “{c.title}”? This cannot be undone.</p>
                <div className="flex gap-2">
                  <button type="button" className="glx-button glx-button-danger" disabled={busy} onClick={() => void confirmDelete(c.id)}>Delete</button>
                  <button type="button" className="glx-button" onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onOpen(c.id)} aria-current={c.id === currentId ? 'true' : undefined}>
                  <span className={`block truncate text-sm ${c.id === currentId ? 'text-glx-cyan' : ''}`}>{c.title}</span>
                  <span className="block text-[11px] text-glx-muted">
                    {c.id === currentId ? 'Open now · ' : ''}{new Date(c.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button type="button" className="text-xs text-glx-muted hover:text-glx-bad py-2" aria-label={`Delete ${c.title}`} onClick={() => setConfirming(c.id)}>Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Chat({ provider, onProviderReset }: { provider: ProviderChoice; onProviderReset: () => void }) {
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const voice = useVoiceInput(text => setDraft(d => (d.trim() ? `${d.trimEnd()} ${text}` : text)))
  const readAloud = useReadAloud()

  useEffect(() => {
    const el = listRef.current
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight })
  }, [messages])
  useEffect(() => () => abortRef.current?.abort(), [])

  const patchLast = (patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) =>
    setMessages(list => list.map((m, i) => (i === list.length - 1 ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)))

  const run = useCallback(async (history: UiMessage[]) => {
    readAloud.stop()
    setMessages([...history, { id: nextId(), role: 'assistant', content: '', streaming: true }])
    setBusy(true)
    setNotice(null)
    const controller = new AbortController()
    abortRef.current = controller

    const outcome = await streamChat(toChatTurns(history), {
      conversationId: conversationId ?? undefined,
      provider,
      signal: controller.signal,
      onRoute: route => patchLast({ route }),
      onDelta: delta => patchLast(m => ({ content: m.content + delta })),
    })
    abortRef.current = null

    let assistant: UiMessage
    if (outcome.error || (outcome.aborted && !outcome.text)) {
      const message = outcome.aborted ? 'Stopped.' : outcome.error!.message
      assistant = {
        id: nextId(), role: 'assistant', isError: true,
        content: outcome.text ? `${outcome.text}\n\n— ${message}` : message,
        hint: outcome.aborted ? null : errorHint(outcome.error!.code, outcome.error!.status),
        code: outcome.error?.code ?? null,
        route: outcome.route,
      }
    } else {
      assistant = {
        id: nextId(), role: 'assistant', content: outcome.text, route: outcome.route,
        meta: metaFrom(outcome.route, outcome.latencyMs),
      }
      readAloud.say(outcome.text)
    }
    const finalList = [...history, assistant]
    setMessages(finalList)
    setBusy(false)

    try {
      const stored: StoredMessage[] = finalList.map(({ role, content, isError, meta }) => ({ role, content, ...(isError ? { isError } : {}), ...(meta ? { meta } : {}) }))
      const id = await saveConversation(conversationId, stored)
      setConversationId(id)
      void queryClient.invalidateQueries({ queryKey: ['glixel', 'conversations'] })
    } catch {
      setNotice('This exchange could not be saved to history.')
    }
  }, [conversationId, provider, queryClient, readAloud])

  function send() {
    const text = draft.trim()
    if (!text || busy) return
    if (voice.state === 'listening' || voice.state === 'processing') voice.cancel()
    setDraft('')
    void run([...messages, { id: nextId(), role: 'user', content: text }])
  }

  // Retry drops the failed reply and asks again with the same turns.
  function retry() {
    if (busy) return
    const lastUser = messages.map(m => m.role).lastIndexOf('user')
    if (lastUser < 0) return
    void run(messages.slice(0, lastUser + 1))
  }

  function newConversation() {
    abortRef.current?.abort()
    readAloud.stop()
    setMessages([])
    setConversationId(null)
    setNotice(null)
  }

  async function open(id: number) {
    setShowHistory(false)
    abortRef.current?.abort()
    readAloud.stop()
    setOpening(true)
    try {
      const c = await loadConversation(id)
      setMessages(c.messages.map(m => ({ ...m, id: nextId() })))
      setConversationId(c.id)
      setNotice(null)
    } catch {
      setNotice('Could not open that conversation. Your current chat is unchanged.')
    } finally {
      setOpening(false)
    }
  }

  const title = conversationId !== null && messages.length > 0
    ? titleFrom(messages.find(m => m.role === 'user')?.content ?? '')
    : 'New conversation'
  const lastIsError = messages.length > 0 && messages[messages.length - 1].isError

  return (
    <section className="flex flex-col h-full min-h-0" aria-label="Chat with GLIXEL">
      <div className="flex items-center justify-between gap-2 py-2">
        <button type="button" className="glx-link text-xs shrink-0" onClick={() => setShowHistory(true)}>History</button>
        <p className="min-w-0 truncate text-center text-xs text-glx-muted" data-testid="conversation-title">{title}</p>
        <button type="button" className="glx-link text-xs shrink-0" onClick={newConversation} disabled={busy && messages.length === 0}>New chat</button>
      </div>

      <ul ref={listRef} className="flex-1 min-h-0 overflow-y-auto space-y-3 py-2" data-testid="messages" aria-live="polite" aria-busy={busy}>
        {opening && <li className="py-6 text-center text-sm text-glx-muted list-none">Opening conversation…</li>}
        {!opening && messages.length === 0 && (
          <li className="pt-6 text-center space-y-3 list-none">
            <div className="mx-auto max-w-[180px]"><IntelligenceCore /></div>
            <p className="text-sm text-glx-muted">
              Ask GLIXEL anything. Replies use free models only, and the route is shown under each answer.
            </p>
          </li>
        )}
        {!opening && messages.map((m, i) => (
          <Bubble
            key={m.id} message={m} provider={provider}
            onRetry={m.isError && i === messages.length - 1 && !busy ? retry : undefined}
            onUseFreeLLMAPI={onProviderReset}
          />
        ))}
      </ul>

      {notice && <p className="text-xs text-glx-warn py-1" role="status">{notice}</p>}
      <VoicePanel voice={voice} />

      <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-glx-muted">
        <span data-testid="ai-path">AI path: {provider === 'freellmapi' ? 'FreeLLMAPI' : 'Claude'}</span>
        <span className="flex items-center gap-3">
          {readAloud.speaking && <button type="button" className="glx-link" onClick={readAloud.stop}>Stop speaking</button>}
          {readAloud.supported && (
            <button type="button" className="glx-link" aria-pressed={readAloud.enabled} onClick={readAloud.toggle}>
              Read aloud: {readAloud.enabled ? 'on' : 'off'}
            </button>
          )}
        </span>
      </div>

      <form
        className="glx-composer flex items-end gap-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onSubmit={e => { e.preventDefault(); send() }}
      >
        <label htmlFor="glixel-input" className="sr-only">Message GLIXEL</label>
        <textarea
          id="glixel-input"
          className="glx-input flex-1 resize-none"
          rows={1}
          value={draft}
          placeholder={lastIsError ? 'Retry above, or write again' : 'Message GLIXEL'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia?.('(pointer: fine)').matches) {
              e.preventDefault()
              send()
            }
          }}
        />
        <MicButton voice={voice} disabled={busy} />
        {busy ? (
          <button type="button" className="glx-button" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" className="glx-button" disabled={!draft.trim()}>Send</button>
        )}
      </form>

      {showHistory && (
        <History
          currentId={conversationId}
          onOpen={id => void open(id)}
          onClose={() => setShowHistory(false)}
          onDeleted={id => { if (id === conversationId) newConversation() }}
        />
      )}
    </section>
  )
}
