import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_CONVERSATION_KEY,
  AUTO_TITLE_MAX,
  autoTitle,
  readActiveConversationId,
  relativeTime,
  toStoredMessages,
  writeActiveConversationId,
  type ChatMessage,
} from './playground-conversations'

describe('autoTitle', () => {
  it('names a conversation after its opening user message', () => {
    expect(autoTitle([
      { role: 'user', content: 'How do I rotate a key?' },
      { role: 'assistant', content: 'Open the Keys page…' },
    ])).toBe('How do I rotate a key?')
  })

  it('ignores an assistant message that somehow comes first', () => {
    expect(autoTitle([
      { role: 'assistant', content: 'Ready when you are' },
      { role: 'user', content: 'summarise this' },
    ])).toBe('summarise this')
  })

  it('truncates to a sidebar row and marks it with an ellipsis', () => {
    const title = autoTitle([{ role: 'user', content: 'x'.repeat(200) }])
    expect(title).toHaveLength(AUTO_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
  })

  it('keeps a message of exactly the limit intact', () => {
    const content = 'y'.repeat(AUTO_TITLE_MAX)
    expect(autoTitle([{ role: 'user', content }])).toBe(content)
  })

  it('takes only the first line, so an inlined attachment never becomes the title', () => {
    expect(autoTitle([{
      role: 'user',
      content: 'what changed here?\n\n```notes.txt\nline one\nline two\n```',
    }])).toBe('what changed here?')
  })

  it('collapses runs of whitespace onto one row', () => {
    expect(autoTitle([{ role: 'user', content: '   spaced    out   words   ' }])).toBe('spaced out words')
  })

  it('has nothing to name an empty or image-only opening turn after', () => {
    expect(autoTitle([])).toBe('')
    expect(autoTitle([{ role: 'user', content: '', images: ['data:image/png;base64,AA'] }])).toBe('')
  })
})

describe('toStoredMessages', () => {
  it('drops the in-flight streaming flags and nothing else', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi', images: ['data:image/png;base64,AA'] },
      {
        role: 'assistant',
        content: 'hello',
        reasoning: 'thinking',
        streaming: true,
        meta: {
          platform: 'groq',
          model: 'llama',
          latency: 42,
          fallbackAttempts: 1,
          fusionPanel: [{ platform: 'groq', model: 'a', status: 'ok', content: 'A' }],
          fusionJudge: { platform: 'cerebras', model: 'j' },
          fusionStreaming: true,
        },
      },
    ]

    const stored = toStoredMessages(messages)
    expect(stored[0]).toEqual(messages[0])
    expect(stored[1]).toEqual({
      role: 'assistant',
      content: 'hello',
      reasoning: 'thinking',
      meta: {
        platform: 'groq',
        model: 'llama',
        latency: 42,
        fallbackAttempts: 1,
        fusionPanel: [{ platform: 'groq', model: 'a', status: 'ok', content: 'A' }],
        fusionJudge: { platform: 'cerebras', model: 'j' },
      },
    })
    expect('streaming' in stored[1]).toBe(false)
    expect('fusionStreaming' in (stored[1].meta ?? {})).toBe(false)
  })

  it('leaves an error bubble and a meta-less message alone', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'boom', isError: true },
      { role: 'user', content: 'again' },
    ]
    expect(toStoredMessages(messages)).toEqual(messages)
  })

  it('does not mutate the live transcript', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'x', streaming: true }]
    toStoredMessages(messages)
    expect(messages[0].streaming).toBe(true)
  })
})

describe('relativeTime', () => {
  const now = 1_700_000_000_000

  it('reads anything under a minute as just now', () => {
    expect(relativeTime(now, now)).toEqual({ key: 'justNow', count: 0 })
    expect(relativeTime(now - 59_000, now)).toEqual({ key: 'justNow', count: 0 })
  })

  it('steps through minutes, hours and days', () => {
    expect(relativeTime(now - 60_000, now)).toEqual({ key: 'minutesAgo', count: 1 })
    expect(relativeTime(now - 59 * 60_000, now)).toEqual({ key: 'minutesAgo', count: 59 })
    expect(relativeTime(now - 60 * 60_000, now)).toEqual({ key: 'hoursAgo', count: 1 })
    expect(relativeTime(now - 23 * 3_600_000, now)).toEqual({ key: 'hoursAgo', count: 23 })
    expect(relativeTime(now - 24 * 3_600_000, now)).toEqual({ key: 'daysAgo', count: 1 })
    expect(relativeTime(now - 400 * 86_400_000, now)).toEqual({ key: 'daysAgo', count: 400 })
  })

  it('does not report a future timestamp as negative time', () => {
    expect(relativeTime(now + 5 * 60_000, now)).toEqual({ key: 'justNow', count: 0 })
  })
})

// The tests run in the default node environment (no jsdom), so localStorage is
// stubbed by hand — enough of it for the three calls the helpers make.
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
  return store
}

describe('active conversation id', () => {
  beforeEach(() => { stubStorage() })
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips an id and clears it with null', () => {
    writeActiveConversationId(7)
    expect(readActiveConversationId()).toBe(7)

    writeActiveConversationId(null)
    expect(readActiveConversationId()).toBeNull()
  })

  it('treats junk in storage as no conversation', () => {
    const store = stubStorage()
    for (const raw of ['', 'abc', '0', '-3', '1.5']) {
      store.set(ACTIVE_CONVERSATION_KEY, raw)
      expect(readActiveConversationId(), raw).toBeNull()
    }
  })

  it('survives storage that throws (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    })
    expect(readActiveConversationId()).toBeNull()
    expect(() => writeActiveConversationId(3)).not.toThrow()
    expect(() => writeActiveConversationId(null)).not.toThrow()
  })
})
