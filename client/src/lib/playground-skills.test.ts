import { describe, expect, it } from 'vitest'
import { appendPromptSkill, PLAYGROUND_SKILLS } from './playground-skills'

const codeReview = PLAYGROUND_SKILLS.find(skill => skill.id === 'code-review')!

describe('appendPromptSkill', () => {
  it('uses the skill prompt when there is no existing prompt', () => {
    expect(appendPromptSkill('', codeReview)).toBe(codeReview.prompt)
    expect(appendPromptSkill('  \n ', codeReview)).toBe(codeReview.prompt)
  })

  it('preserves a custom prompt and appends the selected skill', () => {
    expect(appendPromptSkill('  Be concise.  ', codeReview))
      .toBe(`Be concise.\n\n${codeReview.prompt}`)
  })

  it('does not append an already-applied skill a second time', () => {
    const applied = `Be concise.\n\n${codeReview.prompt}`
    expect(appendPromptSkill(applied, codeReview)).toBe(applied)
  })

  it('contains unique, non-empty built-in prompts', () => {
    expect(PLAYGROUND_SKILLS.length).toBeGreaterThan(1)
    expect(new Set(PLAYGROUND_SKILLS.map(skill => skill.id)).size).toBe(PLAYGROUND_SKILLS.length)
    expect(new Set(PLAYGROUND_SKILLS.map(skill => skill.prompt)).size).toBe(PLAYGROUND_SKILLS.length)
    for (const skill of PLAYGROUND_SKILLS) {
      expect(skill.name.trim()).not.toBe('')
      expect(skill.description.trim()).not.toBe('')
      expect(skill.prompt.trim()).not.toBe('')
    }
  })
})
