import { describe, expect, it } from 'vitest'
import { moveProviderMember, orderedProviderMembers, providerOrderForSave } from './provider-preferences'

const members = [{ id: 'groq' }, { id: 'nvidia' }, { id: 'ollama' }]

describe('provider preference ordering', () => {
  it('preserves automatic order when no preference was configured', () => {
    expect(orderedProviderMembers(members, undefined, member => member.id).map(member => member.id))
      .toEqual(['groq', 'nvidia', 'ollama'])
  })

  it('puts explicit members first and leaves newly discovered members in automatic order', () => {
    const ordered = orderedProviderMembers(
      members,
      { mode: 'preferred', memberOrder: ['nvidia', 'groq'] },
      member => member.id,
    )
    expect(ordered.map(member => member.id)).toEqual(['nvidia', 'groq', 'ollama'])
  })

  it('moves one member without mutating the source list', () => {
    expect(moveProviderMember(members, 1, -1).map(member => member.id)).toEqual(['nvidia', 'groq', 'ollama'])
    expect(members.map(member => member.id)).toEqual(['groq', 'nvidia', 'ollama'])
  })

  it('retains temporarily absent provider identities when saving visible order', () => {
    expect(providerOrderForSave(
      [{ id: 'nvidia' }, { id: 'groq' }],
      ['groq', 'sambanova', 'nvidia'],
      member => member.id,
    )).toEqual(['nvidia', 'groq', 'sambanova'])
  })
})
