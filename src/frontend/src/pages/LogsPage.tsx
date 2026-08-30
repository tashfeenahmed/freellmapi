import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, Pause, Play, ScrollText, Trash2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ConfirmButton } from '@/components/confirm-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import {
  advanceCursor,
  buildLogsQuery,
  clampMessage,
  collectProviders,
  DEFAULT_LOG_LEVELS,
  EMPTY_LOG_COUNTS,
  formatLogTime,
  isLongMessage,
  levelsCsv,
  LOG_BUFFER_LIMIT,
  LOG_LEVELS,
  LOG_PAGE_LIMIT,
  LOG_POLL_MS,
  mergeEntries,
  toggleLevel,
  type LogCounts,
  type LogEntry,
  type LogLevel,
  type LogsResponse,
} from '@/lib/logs'

// Typing in the search box must not fire a request per keystroke; the server
// re-runs the whole query from scratch for every filter change.
const SEARCH_DEBOUNCE_MS = 300

// How close to the bottom still counts as "watching the tail", in pixels. Same
// slack (and the same direction-aware detach below) as the Playground
// transcript: an exact comparison never matches on sub-pixel scroll positions,
// and a couple of lines' worth keeps a stray trackpad nudge from detaching.
const SCROLL_FOLLOW_SLACK = 40

// Level colors follow the dashboard's existing severity ramp (see the penalty
// inspector): red for error, amber for warn, a calm blue for info, and plain
// muted for debug — which is noise you opted into.
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-sky-600/15 text-sky-700 dark:text-sky-400',
  warn: 'bg-amber-600/15 text-amber-700 dark:text-amber-400',
  error: 'bg-destructive/10 text-destructive',
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  )
}

function LogRow({
  entry,
  expanded,
  onToggleExpand,
  expandLabel,
  collapseLabel,
}: {
  entry: LogEntry
  expanded: boolean
  onToggleExpand: () => void
  expandLabel: string
  collapseLabel: string
}) {
  const long = isLongMessage(entry.message)
  return (
    <div
      data-log-level={entry.level}
      className="flex items-start gap-2 rounded-lg px-2 py-1 font-mono text-[11px] leading-relaxed hover:bg-muted/40"
    >
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatLogTime(entry.ts)}</span>
      <Badge
        variant="secondary"
        className={cn('h-4 shrink-0 rounded px-1 font-mono text-[10px] uppercase', LEVEL_CLASS[entry.level])}
      >
        {entry.level}
      </Badge>
      <div className="min-w-0 flex-1">
        {(entry.source || entry.provider || entry.model || entry.event || entry.requestId) && (
          <span className="me-1.5 inline-flex flex-wrap items-center gap-1 align-top">
            {entry.source && <Chip>{entry.source}</Chip>}
            {entry.provider && <Chip>{entry.provider}</Chip>}
            {entry.model && <Chip>{entry.model}</Chip>}
            {entry.event && <Chip>{entry.event}</Chip>}
            {entry.requestId && <Chip>#{entry.requestId}</Chip>}
          </span>
        )}
        <span className="whitespace-pre-wrap wrap-break-word">
          {long && !expanded ? clampMessage(entry.message) : entry.message}
        </span>
        {long && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="ms-1.5 align-baseline text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {expanded ? collapseLabel : expandLabel}
          </button>
        )}
      </div>
    </div>
  )
}

export default function LogsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [levels, setLevels] = useState<LogLevel[]>(() => [...DEFAULT_LOG_LEVELS])
  const [provider, setProvider] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [paused, setPaused] = useState(false)

  // The tail itself lives in component state, not in the query cache: each poll
  // returns only what is NEWER than the cursor, so the buffer is the sum of
  // every response since the last filter change (capped, oldest evicted).
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [counts, setCounts] = useState<LogCounts>(EMPTY_LOG_COUNTS)
  const [providers, setProviders] = useState<string[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  // Live-tail state for RENDER: whether the reader is parked at the bottom, and
  // (when they are not) the newest id they had already seen when they detached.
  // Anything newer than that is what the "Jump to latest" pill is offering.
  const [follow, setFollow] = useState<{ following: boolean; seenId: number | null }>({
    following: true,
    seenId: null,
  })

  const cursorRef = useRef<number | null>(null)
  // Bumped on every filter change. A response tagged with an older stream is
  // dropped rather than pollute the tail the user is now watching.
  const streamRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)

  // Every filter is applied server-side, so changing one invalidates both the
  // buffer and the cursor: the next fetch is a fresh newest-N page. Each filter
  // control calls this as part of its own change handler.
  const resetStream = useCallback(() => {
    streamRef.current += 1
    cursorRef.current = null
    followRef.current = true
    lastScrollTopRef.current = 0
    setEntries([])
    setExpanded(new Set())
    setFollow({ following: true, seenId: null })
  }, [])

  // Typing must not fire a request per keystroke: the committed `search` (and
  // with it the query key) only moves once the box has been quiet for a beat.
  useEffect(() => {
    const trimmed = searchInput.trim()
    if (trimmed === search) return
    const timer = window.setTimeout(() => {
      setSearch(trimmed)
      resetStream()
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput, search, resetStream])

  const filterKey = `${levelsCsv(levels)}|${search}|${provider}`

  const query = useQuery({
    queryKey: ['logs', filterKey],
    // Nothing selected means nothing to ask for; the page says so instead.
    enabled: levels.length > 0,
    // First call has no cursor (newest 200); every later call is incremental.
    // The merge happens here rather than in an effect on `data` because
    // react-query's structural sharing can hand back an identical object for
    // an unchanged response — and an empty poll still has to advance the cursor.
    queryFn: async () => {
      const stream = streamRef.current
      const response = await apiFetch<LogsResponse>(
        buildLogsQuery({ levels, q: search, provider, sinceId: cursorRef.current, limit: LOG_PAGE_LIMIT }),
      )
      // Filters changed while this was in flight: its rows belong to a query
      // the user has already left, and its cursor to a different stream.
      if (streamRef.current !== stream) return response
      const incoming = response.entries ?? []
      cursorRef.current = advanceCursor(cursorRef.current, { entries: incoming, nextId: response.nextId })
      setCounts(response.counts ?? EMPTY_LOG_COUNTS)
      setProviders(prev => collectProviders(prev, incoming))
      setEntries(prev => mergeEntries(prev, incoming))
      return response
    },
    refetchInterval: paused ? false : LOG_POLL_MS,
    // A backgrounded tab burns no requests; polling resumes on focus.
    refetchIntervalInBackground: false,
    // Pause has to mean paused — otherwise coming back to the tab would sneak
    // a fetch past it.
    refetchOnWindowFocus: !paused,
    refetchOnReconnect: !paused,
  })

  const clearLogs = useMutation({
    mutationFn: () => apiFetch<{ ok: true }>('/api/logs/clear', { method: 'POST' }),
    onSuccess: () => {
      resetStream()
      setCounts(EMPTY_LOG_COUNTS)
      setProviders([])
      toast.success(t('logs.cleared'))
      // The cursor is back to null, so the invalidated query refetches from scratch.
      void queryClient.invalidateQueries({ queryKey: ['logs'] })
    },
  })

  const newestId = entries.length ? entries[entries.length - 1].id : null

  // Follow the tail only while the reader is parked at the bottom. Judging by
  // direction (not position alone) keeps our own smooth scroll — which always
  // travels downwards — from being mistaken for the user taking over, whatever
  // they scrolled with: wheel, keys, or the bar.
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const top = el.scrollTop
    const movedUp = top < lastScrollTopRef.current - 1
    lastScrollTopRef.current = top
    if (el.scrollHeight - top - el.clientHeight <= SCROLL_FOLLOW_SLACK) {
      followRef.current = true
      setFollow(current => (current.following ? current : { following: true, seenId: null }))
    } else if (movedUp) {
      followRef.current = false
      setFollow(current => (current.following ? { following: false, seenId: newestId } : current))
    }
  }

  // mergeEntries returns the SAME array when a poll brought nothing, so this
  // only runs on real output — an idle server never yanks the viewport.
  useEffect(() => {
    if (!entries.length) return
    if (followRef.current) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  const jumpToLatest = () => {
    followRef.current = true
    setFollow({ following: true, seenId: null })
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const toggleExpanded = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Only the FIRST page shows skeletons; a poll that comes back empty must not
  // flash them over a quiet-but-working tail every three seconds.
  const loading = query.isPending && !query.isError
  // Offer the jump only when there is something below the fold to jump TO.
  const showJump = !follow.following && newestId != null && (follow.seenId == null || newestId > follow.seenId)

  return (
    <div>
      <PageHeader
        title={t('logs.title')}
        description={t('logs.description')}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={paused}
              onClick={() => setPaused(current => !current)}
            >
              {paused ? <Play /> : <Pause />}
              {paused ? t('logs.resume') : t('logs.pause')}
            </Button>
            <ConfirmButton
              variant="outline"
              size="sm"
              disabled={clearLogs.isPending}
              onConfirm={() => clearLogs.mutate()}
            >
              <Trash2 />
              {t('logs.clear')}
            </ConfirmButton>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('logs.levelFilter')}>
          {LOG_LEVELS.map(level => {
            const active = levels.includes(level)
            return (
              <button
                key={level}
                type="button"
                aria-pressed={active}
                data-level={level}
                onClick={() => {
                  setLevels(current => toggleLevel(current, level))
                  resetStream()
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-4xl border border-transparent px-2.5 text-xs font-medium transition-colors',
                  active ? LEVEL_CLASS[level] : 'bg-muted/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`logs.levels.${level}`)}
                <span className="tabular-nums opacity-70">{counts[level]}</span>
              </button>
            )
          })}
        </div>

        <Select
          value={provider}
          onValueChange={(value) => {
            setProvider(value ?? 'all')
            resetStream()
          }}
        >
          <SelectTrigger size="sm" aria-label={t('common.provider')}>
            <SelectValue>
              {(value: string) => (!value || value === 'all' ? t('analytics.allProviders') : value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('analytics.allProviders')}</SelectItem>
            {providers.map(name => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t('logs.searchPlaceholder')}
          aria-label={t('logs.searchPlaceholder')}
          className="h-7 w-full sm:w-64"
        />
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{t('logs.countsHint')}</p>

      {query.isError && (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('logs.loadFailed')}{' '}
          {query.error instanceof Error ? query.error.message : String(query.error ?? '')}
        </div>
      )}

      <div className="relative rounded-3xl border bg-card">
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="max-h-[65vh] min-h-[240px] overflow-y-auto p-3"
        >
          {levels.length === 0 ? (
            <EmptyState
              className="border-0"
              icon={ScrollText}
              title={t('logs.noLevelsTitle')}
              description={t('logs.noLevelsDescription')}
            />
          ) : loading ? (
            <div className="space-y-1.5">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-4 rounded" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            // On a failed load the banner above already says what happened;
            // pairing it with "nothing here yet" would just muddy the message.
            query.isError ? null : (
              <EmptyState
                className="border-0"
                icon={ScrollText}
                title={t('logs.emptyTitle')}
                description={t('logs.emptyDescription')}
              />
            )
          ) : (
            entries.map(entry => (
              <LogRow
                key={entry.id}
                entry={entry}
                expanded={expanded.has(entry.id)}
                onToggleExpand={() => toggleExpanded(entry.id)}
                expandLabel={t('logs.showMore')}
                collapseLabel={t('logs.showLess')}
              />
            ))
          )}
          <div ref={endRef} />
        </div>

        {showJump && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={jumpToLatest}
            className="absolute inset-x-0 bottom-3 mx-auto w-fit shadow-sm"
          >
            <ArrowDownToLine />
            {t('logs.jumpToLatest')}
          </Button>
        )}
      </div>

      {entries.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('logs.buffered', { count: entries.length, max: LOG_BUFFER_LIMIT })}
        </p>
      )}
    </div>
  )
}
