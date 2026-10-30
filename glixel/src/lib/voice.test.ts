import { describe, expect, it } from 'vitest'
import { recognitionErrorMessage, SPEAK_MAX_CHARS, speakableText } from './voice'

describe('speakableText', () => {
  it('reads prose and skips code, tables, links and images', () => {
    const text = speakableText([
      '# Title', '', 'Run **this** with `npm ci`:', '', '```bash', 'npm ci && npm run build', '```', '',
      '| a | b |', '|---|---|', '| 1 | 2 |', '', 'See [the guide](https://x.dev/guide) or https://y.dev.', '![chart](https://z.dev/c.png)',
    ].join('\n'))
    expect(text).toBe('Title Run this with npm ci: (code block on screen) See the guide or a link')
  })

  it('cuts long replies at a sentence and says the rest is on screen', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const text = speakableText(long)
    expect(text.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS + 30)
    expect(text).toMatch(/is here\. The rest is on screen\.$/)
  })
})

describe('recognitionErrorMessage', () => {
  it('explains permission problems', () => {
    expect(recognitionErrorMessage('not-allowed')).toMatch(/Allow the microphone/)
    expect(recognitionErrorMessage('something-new')).toMatch(/type instead/)
  })
})
