import { describe, expect, it } from 'vitest'
import { addAlias, aliasesFor, normalizeInto, removeAlias, type AliasMerge } from './alias-merge'

const merges: AliasMerge[] = [
  { into: 'GPT-4.1', keys: ['custom:gpt41-relay'] },
  { into: 'Llama 3.3 70B', keys: ['custom:llama-relay', 'custom:llama-backup'] },
]

describe('normalizeInto (#790)', () => {
  it('ignores case, separators, and surrounding space', () => {
    expect(normalizeInto('  Llama-3.3_70B ')).toBe('llama 3.3 70b')
  })
})

describe('aliasesFor (#790)', () => {
  it('returns only the aliases of the named group', () => {
    expect(aliasesFor(merges, 'Llama 3.3 70B')).toEqual(['custom:llama-relay', 'custom:llama-backup'])
  })

  it('matches the group through normalization', () => {
    expect(aliasesFor(merges, 'llama-3.3-70b')).toEqual(['custom:llama-relay', 'custom:llama-backup'])
  })

  it('returns nothing for a group with no merges', () => {
    expect(aliasesFor(merges, 'Claude Sonnet 4')).toEqual([])
  })
})

describe('addAlias (#790)', () => {
  it('keeps the aliases already merged into the group', () => {
    const next = addAlias(merges, 'Llama 3.3 70B', 'custom:llama-third')
    expect(aliasesFor(next, 'Llama 3.3 70B')).toEqual([
      'custom:llama-relay', 'custom:llama-backup', 'custom:llama-third',
    ])
  })

  it('leaves other groups untouched', () => {
    const next = addAlias(merges, 'Llama 3.3 70B', 'custom:llama-third')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })

  it('creates the entry for a group that had none', () => {
    const next = addAlias(merges, 'Claude Sonnet 4', 'custom:claude-relay')
    expect(aliasesFor(next, 'Claude Sonnet 4')).toEqual(['custom:claude-relay'])
    expect(next).toHaveLength(3)
  })

  it('trims the alias and ignores a blank one', () => {
    expect(aliasesFor(addAlias(merges, 'GPT-4.1', '  custom:x  '), 'GPT-4.1'))
      .toEqual(['custom:gpt41-relay', 'custom:x'])
    expect(addAlias(merges, 'GPT-4.1', '   ')).toBe(merges)
  })

  it('does not duplicate an alias that is already merged', () => {
    const next = addAlias(merges, 'GPT-4.1', 'custom:gpt41-relay')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })
})

describe('removeAlias (#790)', () => {
  it('drops one alias and keeps the rest of the group', () => {
    const next = removeAlias(merges, 'Llama 3.3 70B', 'custom:llama-relay')
    expect(aliasesFor(next, 'Llama 3.3 70B')).toEqual(['custom:llama-backup'])
  })

  it('never touches another group that sits at the same visible index', () => {
    // The page renders only this group's aliases, so the first row on screen is
    // entry #1 in the full list — removing by row index used to delete GPT-4.1's.
    const next = removeAlias(merges, 'Llama 3.3 70B', 'custom:llama-relay')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })

  it('removes the whole entry once its last alias is gone', () => {
    const next = removeAlias(merges, 'GPT-4.1', 'custom:gpt41-relay')
    expect(next).toEqual([{ into: 'Llama 3.3 70B', keys: ['custom:llama-relay', 'custom:llama-backup'] }])
  })

  it('is a no-op for an alias that is not merged here', () => {
    expect(removeAlias(merges, 'GPT-4.1', 'custom:nope')).toEqual(merges)
  })
})
