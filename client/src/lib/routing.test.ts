import { describe, it, expect } from 'vitest'
import {
  groupMatchesQuery,
  isMemberSplit,
  memberEndpointTitle,
  memberOverrideKey,
  memberProviderLabel,
  providerPinId,
  splitsWithoutMember,
  tightestRateLimit,
  type RateLimitUsageRow,
} from './routing'

// Per-endpoint identity must be INVISIBLE until two endpoints actually serve the
// same model id (#651). The server sends `endpointScope` / `qualifiedModelId` on
// every custom row — including the only relay of a one-endpoint install — so any
// gate written against those fields alone leaks the user's own base URL. These
// cases pin the gate to the collision itself.

type R = {
  platform: string; modelId: string; source?: 'catalog' | 'custom'
  keyLabel?: string | null; endpointScope?: string | null; qualifiedModelId?: string | null
  displayName?: string
}

const soloRelay: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Custom',
  endpointScope: 'http://192.168.1.50:11434/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#192.168.1.50-11434-v1',
}
const relayA: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Relay A',
  endpointScope: 'https://relay-a.example.com/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#relay-a.example.com-v1',
}
const relayB: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Relay B',
  endpointScope: 'https://relay-b.example.com/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#relay-b.example.com-v1',
}
const catalog: R = { platform: 'groq', modelId: 'llama-3.3-70b', source: 'catalog' }

describe('single-endpoint install stays un-qualified', () => {
  it('labels the lone relay by its key label only', () => {
    expect(memberProviderLabel(soloRelay, [soloRelay])).toBe('Custom')
  })

  it('reveals no endpoint URL on hover', () => {
    expect(memberEndpointTitle(soloRelay, [soloRelay])).toBeUndefined()
  })

  it('offers the bare model id, never the qualified one', () => {
    expect(providerPinId(soloRelay, [soloRelay])).toBe('deepseek-v3.1')
  })

  it('leaves catalog rows entirely alone', () => {
    expect(memberProviderLabel(catalog, [catalog, soloRelay])).toBe('groq')
    expect(memberEndpointTitle(catalog, [catalog, soloRelay])).toBeUndefined()
  })
})

describe('two endpoints serving one model id', () => {
  const both = [relayA, relayB]

  it('appends the endpoint to each label', () => {
    expect(memberProviderLabel(relayA, both)).toBe('Relay A · relay-a.example.com/v1')
    expect(memberProviderLabel(relayB, both)).toBe('Relay B · relay-b.example.com/v1')
  })

  it('reveals the full endpoint URL on hover', () => {
    expect(memberEndpointTitle(relayA, both)).toBe('https://relay-a.example.com/v1')
    expect(memberEndpointTitle(relayB, both)).toBe('https://relay-b.example.com/v1')
  })

  it('offers the qualified id so a copy pins one relay', () => {
    expect(providerPinId(relayA, both)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(providerPinId(relayB, both)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
  })

  it('does not disambiguate a DIFFERENT model id that only one relay serves', () => {
    const soloOnA: R = { ...relayA, modelId: 'qwen-3' }
    const siblings = [soloOnA, relayA, relayB]
    expect(memberProviderLabel(soloOnA, siblings)).toBe('Relay A')
    expect(memberEndpointTitle(soloOnA, siblings)).toBeUndefined()
    expect(providerPinId(soloOnA, siblings)).toBe('qwen-3')
  })
})


// Display name is presentation, never identity (#651). Renaming one relay's copy
// moves it into a different display-name group, but the two rows still share
// (platform, model_id) — so the disambiguation must key on that pair and nothing
// else, and the split/merge override must name ONE relay's row.
describe('two endpoints whose copies were renamed apart', () => {
  const renamedA: R = { ...relayA, displayName: 'DeepSeek via A' }
  const all = [renamedA, relayB]

  it('still labels each with its endpoint', () => {
    expect(memberProviderLabel(renamedA, all)).toBe('Relay A · relay-a.example.com/v1')
    expect(memberProviderLabel(relayB, all)).toBe('Relay B · relay-b.example.com/v1')
  })

  it('still hands out the qualified id to copy', () => {
    expect(providerPinId(renamedA, all)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(providerPinId(relayB, all)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
  })

  it('still reveals the endpoint on hover', () => {
    expect(memberEndpointTitle(renamedA, all)).toBe('https://relay-a.example.com/v1')
  })
})

describe('split / merge override key', () => {
  it('names one relay\'s row, not every custom row with that model id', () => {
    expect(memberOverrideKey(relayA)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(memberOverrideKey(relayB)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
    expect(memberOverrideKey(relayA)).not.toBe(memberOverrideKey(relayB))
  })

  it('keeps the plain member id for rows with no endpoint of their own', () => {
    expect(memberOverrideKey(catalog)).toBe('groq:llama-3.3-70b')
    expect(memberOverrideKey({ platform: 'custom', modelId: 'legacy' })).toBe('custom:legacy')
  })
})

describe('collision detection keys on (platform, model_id)', () => {
  it('ignores a same-id row on a different platform', () => {
    const sameIdOnCatalog: R = { platform: 'groq', modelId: 'deepseek-v3.1', source: 'catalog' }
    expect(memberProviderLabel(soloRelay, [soloRelay, sameIdOnCatalog])).toBe('Custom')
    expect(providerPinId(soloRelay, [soloRelay, sameIdOnCatalog])).toBe('deepseek-v3.1')
  })
})

// A split persisted BEFORE per-endpoint identity names the row in the plain
// "platform:modelId" form. The override key is qualified now, so a naive
// equality check stops recognising it: the row stays split with no control to
// merge it back. Rewriting the stored key would be a silent data migration for
// a cosmetic gain, so matching has to accept both forms instead.
describe('pre-#651 split overrides stay undoable', () => {
  const legacySplit = [{ member: 'custom:deepseek-v3.1' }]
  const qualifiedSplit = [{ member: 'custom:deepseek-v3.1#relay-a.example.com-v1' }]

  it('recognises a split stored in the plain form', () => {
    expect(isMemberSplit(legacySplit, relayA)).toBe(true)
  })

  it('recognises one stored in the qualified form', () => {
    expect(isMemberSplit(qualifiedSplit, relayA)).toBe(true)
  })

  it('removes the entry that is actually stored, whichever form it uses', () => {
    expect(splitsWithoutMember(legacySplit, relayA)).toEqual([])
    expect(splitsWithoutMember(qualifiedSplit, relayA)).toEqual([])
  })

  it('does not treat a sibling relay as split by the other one\'s entry', () => {
    expect(isMemberSplit(qualifiedSplit, relayB)).toBe(false)
    expect(splitsWithoutMember(qualifiedSplit, relayB)).toEqual(qualifiedSplit)
  })

  it('still matches a plain entry on a row that has no endpoint at all', () => {
    const legacyRow = { platform: 'custom', modelId: 'legacy', source: 'custom' as const }
    expect(isMemberSplit([{ member: 'custom:legacy' }], legacyRow)).toBe(true)
  })

  it('leaves catalog rows on the plain form only', () => {
    expect(isMemberSplit([{ member: 'groq:llama-3.3-70b' }], catalog)).toBe(true)
  })
})

// ── Group-level rate-limit badge (#876, #921 follow-up) ──────────────────────
// The badge means "how close is this logical model to being unusable". A model
// is unusable only when EVERY provider serving it is out of headroom, so the
// group number follows the BEST member. Taking the worst member painted a
// five-provider group red the moment one provider ran dry.

function usageRow(modelDbId: number, w: Partial<Pick<RateLimitUsageRow, 'rpm' | 'rpd' | 'tpm'>> = {}): RateLimitUsageRow {
  return {
    modelDbId,
    platform: 'p' + modelDbId,
    modelId: 'm' + modelDbId,
    rpm: w.rpm ?? null,
    rpd: w.rpd ?? null,
    tpm: w.tpm ?? null,
  }
}

describe('tightestRateLimit', () => {
  it('returns null with no rows at all', () => {
    expect(tightestRateLimit([])).toBeNull()
  })

  it('returns null when every window is idle (no badge for an unused model)', () => {
    expect(tightestRateLimit([usageRow(1, { rpm: { used: 0, limit: 30 } })])).toBeNull()
  })

  it('returns null when rows carry no windows at all (model has no limits)', () => {
    expect(tightestRateLimit([usageRow(1)])).toBeNull()
  })

  it('reports a single member as-is', () => {
    expect(tightestRateLimit([usageRow(1, { rpm: { used: 21, limit: 30 } })]))
      .toEqual({ kind: 'RPM', used: 21, limit: 30 })
  })

  it('within one member picks the TIGHTEST window (that member is blocked by it)', () => {
    const row = usageRow(1, {
      rpm: { used: 3, limit: 30 },     // 10%
      rpd: { used: 900, limit: 1000 }, // 90% ← binding
      tpm: { used: 100, limit: 1000 }, // 10%
    })
    expect(tightestRateLimit([row])).toEqual({ kind: 'RPD', used: 900, limit: 1000 })
  })

  it('across a group picks the member with the MOST headroom, not the exhausted one', () => {
    const exhausted = usageRow(1, { rpm: { used: 30, limit: 30 } })
    const easy = usageRow(2, { rpm: { used: 2, limit: 30 } })
    expect(tightestRateLimit([exhausted, easy])).toEqual({ kind: 'RPM', used: 2, limit: 30 })
  })

  it('one exhausted provider out of five does not decide the badge', () => {
    const rows = [
      usageRow(1, { rpd: { used: 1000, limit: 1000 } }),
      usageRow(2, { rpd: { used: 10, limit: 1000 } }),
      usageRow(3, { rpd: { used: 50, limit: 1000 } }),
      usageRow(4, { rpd: { used: 5, limit: 1000 } }),
      usageRow(5, { rpd: { used: 400, limit: 1000 } }),
    ]
    expect(tightestRateLimit(rows)).toEqual({ kind: 'RPD', used: 5, limit: 1000 })
  })

  it('goes red only when every member is exhausted', () => {
    const rows = [
      usageRow(1, { rpm: { used: 30, limit: 30 } }),
      usageRow(2, { rpm: { used: 60, limit: 60 } }),
    ]
    const tight = tightestRateLimit(rows)!
    expect(tight.used / tight.limit).toBe(1)
  })

  it('a fully idle member wins over a busy one and suppresses the badge', () => {
    const rows = [
      usageRow(1, { rpm: { used: 29, limit: 30 } }),
      usageRow(2, { rpm: { used: 0, limit: 30 } }),
    ]
    expect(tightestRateLimit(rows)).toBeNull()
  })

  it('ignores a zero limit rather than dividing by it', () => {
    const rows = [usageRow(1, { rpm: { used: 5, limit: 0 } })]
    expect(tightestRateLimit(rows)).toBeNull()
  })

  it('compares members by ratio, not by raw counts', () => {
    // 500/100000 (0.5%) has far more headroom than 8/10 (80%), despite the
    // bigger absolute number.
    const rows = [
      usageRow(1, { rpm: { used: 8, limit: 10 } }),
      usageRow(2, { tpm: { used: 500, limit: 100_000 } }),
    ]
    expect(tightestRateLimit(rows)).toEqual({ kind: 'TPM', used: 500, limit: 100_000 })
  })
})

// #1056: a relay added as a custom endpoint carries platform 'custom', so
// searching the provider's name ("unorouter") found nothing even though the
// table prints the endpoint host on the row.
describe('groupMatchesQuery (#1056)', () => {
  const member = (over: Record<string, unknown> = {}) => ({
    platform: 'custom', modelId: 'glm-5.1', displayName: 'GLM 5.1',
    source: 'custom' as const, keyLabel: null,
    endpointScope: 'https://api.unorouter.com/v1', ...over,
  })
  const group = (members: ReturnType<typeof member>[]) => ({ label: 'GLM 5.1', members })

  it('matches a custom endpoint host the table displays', () => {
    expect(groupMatchesQuery(group([member()]), 'unorouter')).toBe(true)
    expect(groupMatchesQuery(group([member()]), 'api.unorouter.com')).toBe(true)
  })

  it('matches the operator-given key label', () => {
    const g = group([member({ endpointScope: null, keyLabel: 'My UnoRouter key' })])
    expect(groupMatchesQuery(g, 'unorouter')).toBe(true)
  })

  it('matches when only ONE member of a multi-provider group is on that endpoint', () => {
    const g = group([
      member({ platform: 'zhipu', source: 'catalog' as const, endpointScope: null }),
      member(),
    ])
    expect(groupMatchesQuery(g, 'unorouter')).toBe(true)
    expect(groupMatchesQuery(g, 'zhipu')).toBe(true)
  })

  it('still matches names, ids and catalog platforms', () => {
    const g = group([member({ platform: 'groq', source: 'catalog' as const, endpointScope: null })])
    expect(groupMatchesQuery(g, 'glm')).toBe(true)
    expect(groupMatchesQuery(g, 'groq')).toBe(true)
    expect(groupMatchesQuery(g, 'mistral')).toBe(false)
  })
})
