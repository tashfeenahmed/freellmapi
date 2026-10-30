import { describe, expect, it } from 'vitest'
import {
  configuredProviders, formatLatency, formatPercent, freshness, parseServerTime, STALE_AFTER_MS, summarizeFleet,
  type ProviderTelemetry,
} from './telemetry'

function p(overrides: Partial<ProviderTelemetry> & Pick<ProviderTelemetry, 'platform' | 'state'>): ProviderTelemetry {
  return {
    name: overrides.platform, kind: 'chat', automaticRouting: { eligible: true }, lastCheckedAt: null,
    models: { enabled: 2, automaticallyRoutable: 2 },
    traffic24h: { requests: 0, successRate: null, avgLatencyMs: null },
    cooldowns: { active: 0, soonestExpiresAt: null },
    ...overrides,
  }
}

describe('freshness', () => {
  const now = 1_000_000
  it('distinguishes loading, live, stale and unavailable', () => {
    expect(freshness({ hasData: false, fetchedAt: undefined, failed: false, loading: true, now })).toBe('loading')
    expect(freshness({ hasData: false, fetchedAt: undefined, failed: true, loading: false, now })).toBe('unavailable')
    expect(freshness({ hasData: true, fetchedAt: now - 1000, failed: false, loading: false, now })).toBe('live')
    expect(freshness({ hasData: true, fetchedAt: now - STALE_AFTER_MS - 1, failed: false, loading: false, now })).toBe('stale')
    expect(freshness({ hasData: true, fetchedAt: now, failed: true, loading: false, now })).toBe('stale')
  })
})

describe('summarizeFleet', () => {
  it('counts chat providers by state and weights rates by requests', () => {
    const s = summarizeFleet([
      p({ platform: 'google', state: 'connected', traffic24h: { requests: 3, successRate: 1, avgLatencyMs: 3000 }, cooldowns: { active: 1, soonestExpiresAt: null } }),
      p({ platform: 'groq', state: 'unhealthy', traffic24h: { requests: 1, successRate: 0, avgLatencyMs: 1000 } }),
      p({ platform: 'mistral', state: 'unconfigured', models: { enabled: 4, automaticallyRoutable: 0 } }),
      p({ platform: 'tavily', state: 'connected', kind: 'search', traffic24h: { requests: 99, successRate: 0, avgLatencyMs: 9 } }),
    ])
    expect(s).toEqual({
      connected: 1, unhealthy: 1, disabled: 0, unconfigured: 1,
      automaticallyRoutableModels: 2, activeCooldowns: 1, requests24h: 4, // connected providers only
      successRate24h: 0.75, avgLatencyMs24h: 2500,
    })
  })

  it('reports no data instead of inventing zeros', () => {
    const s = summarizeFleet([p({ platform: 'google', state: 'connected' })])
    expect(s.successRate24h).toBeNull()
    expect(s.avgLatencyMs24h).toBeNull()
    expect(formatPercent(s.successRate24h)).toBe('no data')
    expect(formatLatency(s.avgLatencyMs24h)).toBe('no data')
  })
})

describe('helpers', () => {
  it('lists configured chat providers with problems first', () => {
    const rows = configuredProviders([
      p({ platform: 'b', state: 'connected' }), p({ platform: 'a', state: 'unhealthy' }),
      p({ platform: 'c', state: 'unconfigured' }), p({ platform: 'd', state: 'disabled' }),
    ])
    expect(rows.map(r => r.platform)).toEqual(['a', 'b', 'd'])
  })

  it('parses ISO and SQLite UTC timestamps, rejecting garbage', () => {
    expect(parseServerTime('2026-10-28 12:00:00')?.toISOString()).toBe('2026-10-28T12:00:00.000Z')
    expect(parseServerTime('2026-10-28T12:00:00.000Z')?.toISOString()).toBe('2026-10-28T12:00:00.000Z')
    expect(parseServerTime('nope')).toBeNull()
    expect(parseServerTime(null)).toBeNull()
  })

  it('formats latency and percentages', () => {
    expect(formatLatency(3186)).toBe('3.2 s')
    expect(formatLatency(420)).toBe('420 ms')
    expect(formatPercent(0.756)).toBe('76%')
  })
})
