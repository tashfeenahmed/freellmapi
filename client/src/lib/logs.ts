// Pure helpers behind the Logs page (the live server-log viewer). Everything
// here is deliberately free of React and of `fetch` so the merging/cursor rules
// — the parts that are easy to get subtly wrong and impossible to eyeball in a
// scrolling tail — can be unit-tested without a running server.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Canonical order: quietest first. Pills, CSVs and counts all follow it. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const

/** Debug is off by default — it is the firehose, and nobody opens the page for it. */
export const DEFAULT_LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'] as const

/** Newest-N the first (cursorless) fetch asks for. */
export const LOG_PAGE_LIMIT = 200

/** How many entries the client keeps; older ones are evicted as new ones land. */
export const LOG_BUFFER_LIMIT = 2000

/** Poll cadence for the incremental (`sinceId`) fetches. */
export const LOG_POLL_MS = 3000

/** Messages longer than this render clamped behind a click-to-expand. */
export const LOG_MESSAGE_CLAMP = 400

/** One row as served by GET /api/logs. */
export interface LogEntry {
  id: number
  /** ISO-8601 timestamp. */
  ts: string
  level: LogLevel
  source?: string
  provider?: string
  model?: string
  event?: string
  requestId?: string
  message: string
}

/** Ring-wide totals per level — NOT filtered by the current query. */
export interface LogCounts {
  debug: number
  info: number
  warn: number
  error: number
}

export const EMPTY_LOG_COUNTS: LogCounts = { debug: 0, info: 0, warn: 0, error: 0 }

export interface LogsResponse {
  entries: LogEntry[]
  /** Highest id the ring holds — the cursor for the next poll, even when `entries` is empty. */
  nextId: number
  counts: LogCounts
}

export interface LogQuery {
  levels: readonly LogLevel[]
  /** Free-text search; blank means "no q param". */
  q?: string
  /** Provider slug, or 'all'/blank for no provider param. */
  provider?: string
  /** Cursor from the previous response; null/undefined on the first fetch. */
  sinceId?: number | null
  limit?: number
}

/**
 * Assemble the GET /api/logs URL. Levels are always sent (server-side
 * filtering, not client-side), in canonical order so the same selection always
 * produces the same string — which is what makes it usable as a query key.
 */
export function buildLogsQuery(query: LogQuery): string {
  const params = new URLSearchParams()
  params.set('levels', levelsCsv(query.levels))
  const q = query.q?.trim()
  if (q) params.set('q', q)
  const provider = query.provider?.trim()
  if (provider && provider !== 'all') params.set('provider', provider)
  if (query.sinceId != null) params.set('sinceId', String(query.sinceId))
  params.set('limit', String(query.limit ?? LOG_PAGE_LIMIT))
  return `/api/logs?${params.toString()}`
}

/** Selected levels as a canonically ordered, de-duplicated CSV. */
export function levelsCsv(levels: readonly LogLevel[]): string {
  const selected = new Set(levels)
  return LOG_LEVELS.filter(level => selected.has(level)).join(',')
}

/**
 * Append the newly polled entries to the buffer, dropping ids already held (a
 * retried poll can re-deliver the tail) and evicting from the front once the
 * cap is passed. Returns the ORIGINAL array when nothing new arrived, so React
 * bails out of the re-render and the live-tail effect does not mistake an empty
 * poll for new output.
 */
export function mergeEntries(
  buffer: readonly LogEntry[],
  incoming: readonly LogEntry[],
  cap: number = LOG_BUFFER_LIMIT,
): LogEntry[] {
  if (!incoming.length) return buffer as LogEntry[]
  const seen = new Set(buffer.map(entry => entry.id))
  const fresh: LogEntry[] = []
  for (const entry of incoming) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    fresh.push(entry)
  }
  if (!fresh.length) return buffer as LogEntry[]
  const merged = [...buffer, ...fresh]
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/**
 * Next poll's `sinceId`. The server's `nextId` is authoritative and is sent even
 * when the page was empty, so an idle ring still advances past entries filtered
 * out by the query instead of re-asking for them forever.
 */
export function advanceCursor(
  current: number | null,
  response: Pick<LogsResponse, 'entries' | 'nextId'>,
): number | null {
  if (typeof response.nextId === 'number' && Number.isFinite(response.nextId)) {
    return response.nextId
  }
  // Defensive: a response without a usable nextId still must not rewind.
  let highest = current ?? null
  for (const entry of response.entries) {
    if (highest == null || entry.id > highest) highest = entry.id
  }
  return highest
}

/** Flip one level pill; the result stays in canonical order. */
export function toggleLevel(levels: readonly LogLevel[], level: LogLevel): LogLevel[] {
  const selected = new Set(levels)
  if (selected.has(level)) selected.delete(level)
  else selected.add(level)
  return LOG_LEVELS.filter(candidate => selected.has(candidate))
}

/**
 * Providers offered by the filter select. The server has no "list providers"
 * endpoint, so the options accumulate from whatever this session has seen and
 * never shrink — losing an option the moment its last entry is evicted would
 * make the select flicker under load.
 */
export function collectProviders(
  known: readonly string[],
  entries: readonly LogEntry[],
): string[] {
  const all = new Set(known)
  let added = false
  for (const entry of entries) {
    const provider = entry.provider?.trim()
    if (!provider || all.has(provider)) continue
    all.add(provider)
    added = true
  }
  if (!added) return known as string[]
  return [...all].sort((a, b) => a.localeCompare(b))
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * Wall-clock time of an entry as HH:MM:SS.mmm in the viewer's zone. Fixed-width
 * on purpose: the tail is monospace and the column must not jitter.
 */
export function formatLogTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--:--.---'
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`
}

/** True when a message is long enough to earn a click-to-expand. */
export function isLongMessage(message: string, clamp: number = LOG_MESSAGE_CLAMP): boolean {
  return message.length > clamp
}

/** The clamped form of a long message (ellipsis included). */
export function clampMessage(message: string, clamp: number = LOG_MESSAGE_CLAMP): string {
  return isLongMessage(message, clamp) ? `${message.slice(0, clamp)}…` : message
}
