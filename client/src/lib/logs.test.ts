import { describe, expect, it } from 'vitest'
import {
  advanceCursor,
  buildLogsQuery,
  clampMessage,
  collectProviders,
  formatLogTime,
  isLongMessage,
  levelsCsv,
  mergeEntries,
  toggleLevel,
  type LogEntry,
  type LogLevel,
} from './logs'

function entry(id: number, extra: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    ts: '2024-01-02T03:04:05.678Z',
    level: 'info',
    message: `message ${id}`,
    ...extra,
  }
}

describe('buildLogsQuery', () => {
  it('always sends the selected levels as a canonically ordered CSV', () => {
    expect(buildLogsQuery({ levels: ['error', 'debug', 'warn'] }))
      .toBe('/api/logs?levels=debug%2Cwarn%2Cerror&limit=200')
  })

  it('omits blank search and the "all" provider sentinel', () => {
    expect(buildLogsQuery({ levels: ['warn'], q: '   ', provider: 'all' }))
      .toBe('/api/logs?levels=warn&limit=200')
  })

  it('sends trimmed search, provider and cursor when present', () => {
    const url = buildLogsQuery({
      levels: ['warn', 'error'],
      q: '  rate limit  ',
      provider: 'groq',
      sinceId: 123,
      limit: 200,
    })
    expect(url).toBe('/api/logs?levels=warn%2Cerror&q=rate+limit&provider=groq&sinceId=123&limit=200')
  })

  it('treats sinceId 0 as a real cursor but null as the first fetch', () => {
    expect(buildLogsQuery({ levels: ['info'], sinceId: 0 })).toContain('sinceId=0')
    expect(buildLogsQuery({ levels: ['info'], sinceId: null })).not.toContain('sinceId')
  })

  it('collapses duplicate levels', () => {
    expect(levelsCsv(['warn', 'warn', 'debug'])).toBe('debug,warn')
  })
})

describe('mergeEntries', () => {
  it('appends new entries in arrival order', () => {
    const merged = mergeEntries([entry(1), entry(2)], [entry(3), entry(4)])
    expect(merged.map(e => e.id)).toEqual([1, 2, 3, 4])
  })

  it('never duplicates an id already in the buffer', () => {
    const merged = mergeEntries([entry(1), entry(2)], [entry(2), entry(3)])
    expect(merged.map(e => e.id)).toEqual([1, 2, 3])
  })

  it('de-duplicates within a single incoming page', () => {
    const merged = mergeEntries([], [entry(1), entry(1), entry(2)])
    expect(merged.map(e => e.id)).toEqual([1, 2])
  })

  it('returns the same array when nothing new arrived', () => {
    const buffer = [entry(1), entry(2)]
    expect(mergeEntries(buffer, [])).toBe(buffer)
    expect(mergeEntries(buffer, [entry(2)])).toBe(buffer)
  })

  it('evicts the oldest entries once the cap is passed', () => {
    const buffer = [entry(1), entry(2), entry(3)]
    const merged = mergeEntries(buffer, [entry(4), entry(5)], 3)
    expect(merged.map(e => e.id)).toEqual([3, 4, 5])
  })

  it('caps a single oversized page too', () => {
    const page = Array.from({ length: 10 }, (_, i) => entry(i + 1))
    expect(mergeEntries([], page, 4).map(e => e.id)).toEqual([7, 8, 9, 10])
  })
})

describe('advanceCursor', () => {
  it('takes the server nextId when entries arrived', () => {
    expect(advanceCursor(10, { entries: [entry(11), entry(12)], nextId: 12 })).toBe(12)
  })

  it('still advances when the page came back empty', () => {
    // Entries the query filtered out still bumped the ring's highest id; not
    // taking nextId here would re-ask for them on every poll, forever.
    expect(advanceCursor(10, { entries: [], nextId: 42 })).toBe(42)
  })

  it('accepts nextId 0 on an empty ring', () => {
    expect(advanceCursor(null, { entries: [], nextId: 0 })).toBe(0)
  })

  it('falls back to the highest seen id when nextId is unusable', () => {
    const broken = { entries: [entry(7), entry(9)], nextId: undefined as unknown as number }
    expect(advanceCursor(3, broken)).toBe(9)
    expect(advanceCursor(20, { entries: [], nextId: NaN })).toBe(20)
  })
})

describe('toggleLevel', () => {
  it('adds a level back in canonical order, not at the end', () => {
    expect(toggleLevel(['warn', 'error'], 'debug')).toEqual(['debug', 'warn', 'error'])
  })

  it('removes a selected level', () => {
    expect(toggleLevel(['info', 'warn', 'error'], 'warn')).toEqual(['info', 'error'])
  })

  it('can empty the selection', () => {
    expect(toggleLevel(['error'], 'error')).toEqual([])
  })

  it('round-trips', () => {
    const start: LogLevel[] = ['info', 'warn', 'error']
    expect(toggleLevel(toggleLevel(start, 'debug'), 'debug')).toEqual(start)
  })
})

describe('collectProviders', () => {
  it('accumulates and sorts, ignoring entries without a provider', () => {
    const providers = collectProviders(['groq'], [
      entry(1, { provider: 'cerebras' }),
      entry(2),
      entry(3, { provider: 'groq' }),
    ])
    expect(providers).toEqual(['cerebras', 'groq'])
  })

  it('returns the same array when no new provider showed up', () => {
    const known = ['groq']
    expect(collectProviders(known, [entry(1, { provider: 'groq' })])).toBe(known)
    expect(collectProviders(known, [])).toBe(known)
  })
})

describe('formatLogTime', () => {
  it('formats local wall-clock time as HH:MM:SS.mmm', () => {
    // Built in local time, so the expectation holds in any timezone.
    const ts = new Date(2024, 0, 2, 3, 4, 5, 678).toISOString()
    expect(formatLogTime(ts)).toBe('03:04:05.678')
  })

  it('zero-pads the milliseconds', () => {
    const ts = new Date(2024, 0, 2, 23, 59, 59, 7).toISOString()
    expect(formatLogTime(ts)).toBe('23:59:59.007')
  })

  it('degrades to a placeholder of the same width on a bad timestamp', () => {
    expect(formatLogTime('not a date')).toBe('--:--:--.---')
  })
})

describe('message clamping', () => {
  it('leaves short messages alone', () => {
    expect(isLongMessage('short', 10)).toBe(false)
    expect(clampMessage('short', 10)).toBe('short')
  })

  it('clamps long messages with an ellipsis', () => {
    const long = 'x'.repeat(50)
    expect(isLongMessage(long, 10)).toBe(true)
    expect(clampMessage(long, 10)).toBe('xxxxxxxxxx…')
  })
})
