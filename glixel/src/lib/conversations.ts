// GLIXEL keeps its history in the existing conversation store
// (/api/conversations), so it is local to your server and shared with the
// dashboard Playground. Nothing is kept in the browser.
import { apiGet, apiSendJson } from './session'
import type { RouteInfo } from './chat'

export interface StoredMessage {
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
  meta?: { platform?: string; model?: string; latency?: number; fallbackAttempts?: number }
}

export interface ConversationSummary {
  id: number
  title: string
  updatedAt: number
}

interface ConversationFull {
  id: number
  title: string
  messages: StoredMessage[]
}

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine || 'New conversation'
}

export function metaFrom(route: RouteInfo | null, latencyMs: number | null): StoredMessage['meta'] | undefined {
  if (!route) return undefined
  return {
    platform: route.platform,
    model: route.model,
    ...(latencyMs !== null ? { latency: latencyMs } : {}),
    fallbackAttempts: route.fallbackAttempts,
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const rows = await apiGet<Array<{ id: number; title: string; updatedAt?: number; updated_at_ms?: number }>>('/api/conversations')
  return rows.map(r => ({ id: r.id, title: r.title || 'Untitled', updatedAt: r.updatedAt ?? r.updated_at_ms ?? 0 }))
}

export async function loadConversation(id: number): Promise<ConversationFull> {
  return apiGet<ConversationFull>(`/api/conversations/${id}`)
}

export async function saveConversation(id: number | null, messages: StoredMessage[]): Promise<number> {
  if (id === null) {
    const firstUser = messages.find(m => m.role === 'user')?.content ?? ''
    const created = await apiSendJson<{ id: number }>('POST', '/api/conversations', { title: titleFrom(firstUser), messages, model: 'auto' })
    return created.id
  }
  await apiSendJson('PUT', `/api/conversations/${id}`, { messages })
  return id
}

export async function deleteConversation(id: number): Promise<void> {
  await apiSendJson('DELETE', `/api/conversations/${id}`)
}
