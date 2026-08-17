import { describe, it, expect } from 'vitest'
import { cn, sqliteUtcToIso, formatSqliteUtcToLocalTime } from '@/lib/utils'

describe('cn (class merge)', () => {
  it('joins truthy classes and resolves tailwind conflicts', () => {
    expect(cn('a', 'b')).toBe('a b')
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn(false && 'hidden', null, undefined, 'block')).toBe('block')
  })
})

describe('sqliteUtcToIso', () => {
  it('tags a space-separated SQLite datetime as UTC', () => {
    expect(sqliteUtcToIso('2026-07-01 10:00:00')).toBe('2026-07-01T10:00:00Z')
  })

  it('leaves an already-ISO value untouched', () => {
    expect(sqliteUtcToIso('2026-07-01T10:00:00.000Z')).toBe('2026-07-01T10:00:00.000Z')
  })
})

describe('formatSqliteUtcToLocalTime', () => {
  it('returns an em dash for null / empty / undefined input', () => {
    expect(formatSqliteUtcToLocalTime(null)).toBe('—')
    expect(formatSqliteUtcToLocalTime(undefined)).toBe('—')
    expect(formatSqliteUtcToLocalTime('')).toBe('—')
  })

  it('returns an em dash for an unparseable value', () => {
    expect(formatSqliteUtcToLocalTime('not-a-date')).toBe('—')
  })

  it('formats a valid UTC datetime into the viewer local time', () => {
    const out = formatSqliteUtcToLocalTime('2026-07-01 10:00:00')
    expect(out).not.toBe('—')
    expect(typeof out).toBe('string')
  })

  it('honours custom Intl options', () => {
    const out = formatSqliteUtcToLocalTime('2026-07-01 10:00:00', { hour: '2-digit' })
    expect(typeof out).toBe('string')
  })
})
