// Saved Playground conversations: the shapes the transcript is stored in, the
// pure helpers the sidebar renders with, and thin wrappers over
// /api/conversations.
//
// Everything derivable (the auto-title, the relative time, what is safe to
// persist) lives here as a plain function so it can be unit-tested without a
// component — the page below only wires it up.

// Relative, not the `@/` alias: the unit tests run under the standalone
// vitest config, which does not carry the app's path aliases.
import { apiFetch } from './api'

export interface FusionPanelEntry {
  platform: string
  model: string
  status?: 'ok' | 'failed'
  content?: string
  error?: string
}

/**
 * One bubble in the Playground transcript. Persisted verbatim (minus
 * `streaming`, see `toStoredMessages`) so a restored conversation renders
 * identically to the live one: routing meta, reasoning and image thumbnails
 * included.
 */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // Data URIs of the images attached to this turn: rendered as thumbnails in
  // the bubble and replayed as `image_url` parts on every follow-up request.
  images?: string[]
  // Request-level failure rendered as a distinct error bubble, not a fake
  // assistant reply.
  isError?: boolean
  // Thinking tokens (`delta.reasoning_content`) accumulated separately from the
  // answer, shown as a collapsible aside above it.
  reasoning?: string
  // True while this bubble is still being filled in by an open stream. Never
  // stored — a saved message is finished by definition.
  streaming?: boolean
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

/** Sidebar row: enough to list a conversation, never its transcript. */
export interface ConversationSummary {
  id: number
  title: string
  model: string | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

/** A conversation with its transcript, as returned by GET /:id. */
export interface Conversation extends Omit<ConversationSummary, 'messageCount'> {
  messages: ChatMessage[]
  systemPrompt: string | null
}

export interface ConversationPatch {
  title?: string
  messages?: ChatMessage[]
  model?: string | null
  systemPrompt?: string | null
}

/** localStorage key holding the conversation the Playground had open. */
export const ACTIVE_CONVERSATION_KEY = 'playground.conversationId'
/** localStorage key holding whether the conversation sidebar is expanded. */
export const SIDEBAR_OPEN_KEY = 'playground.sidebarOpen'

/** Roughly a sidebar row's worth of text. */
export const AUTO_TITLE_MAX = 40

/**
 * The title a conversation gets on its first save: the opening user message,
 * first line only, squeezed onto one row. Returns '' when there is nothing to
 * name it after yet — the caller then leaves the stored title empty, and the
 * next save gets another go at it.
 *
 * Only ever applied to a conversation with no title, so a rename sticks
 * permanently: once the title is non-empty nothing recomputes it.
 */
export function autoTitle(messages: ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user')
  if (!first) return ''
  // Attachments are appended to the typed text as fenced blocks, so the first
  // line is the part the person actually wrote.
  const line = first.content.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  const text = line.replace(/\s+/g, ' ').trim()
  if (text.length <= AUTO_TITLE_MAX) return text
  return `${text.slice(0, AUTO_TITLE_MAX - 1).trimEnd()}…`
}

/**
 * Drop the in-flight-only fields before a save. `streaming` marks a bubble the
 * reader is still filling in; storing it would restore a transcript frozen
 * mid-answer, and the same goes for the fusion trace's own streaming flag.
 */
export function toStoredMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    const stored: ChatMessage = { ...message }
    delete stored.streaming
    if (stored.meta && stored.meta.fusionStreaming !== undefined) {
      stored.meta = { ...stored.meta }
      delete stored.meta.fusionStreaming
    }
    return stored
  })
}

export type RelativeTimeKey = 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Coarse "how long ago" for a sidebar row, as an i18n key plus its count —
 * formatting stays in the component so every locale writes its own phrasing.
 * Anything under a minute (a clock skewed into the future included) is "just
 * now"; beyond that it steps minutes → hours → days and stops, because a
 * conversation from last March does not need its own unit.
 */
export function relativeTime(timestamp: number, now: number = Date.now()): {
  key: RelativeTimeKey
  count: number
} {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return { key: 'justNow', count: 0 }
  if (elapsed < HOUR) return { key: 'minutesAgo', count: Math.floor(elapsed / MINUTE) }
  if (elapsed < DAY) return { key: 'hoursAgo', count: Math.floor(elapsed / HOUR) }
  return { key: 'daysAgo', count: Math.floor(elapsed / DAY) }
}

/** The stored active-conversation id, or null when there isn't a usable one. */
export function readActiveConversationId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CONVERSATION_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function writeActiveConversationId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_CONVERSATION_KEY)
    else localStorage.setItem(ACTIVE_CONVERSATION_KEY, String(id))
  } catch {
    // Private-mode / quota failures are not worth breaking a chat over.
  }
}

export function listConversations(): Promise<ConversationSummary[]> {
  return apiFetch<ConversationSummary[]>('/api/conversations')
}

export function getConversation(id: number): Promise<Conversation> {
  return apiFetch<Conversation>(`/api/conversations/${id}`)
}

export function createConversation(patch: ConversationPatch): Promise<Conversation> {
  return apiFetch<Conversation>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(patch),
  })
}

export function updateConversation(id: number, patch: ConversationPatch): Promise<Conversation> {
  return apiFetch<Conversation>(`/api/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function deleteConversation(id: number): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' })
}
