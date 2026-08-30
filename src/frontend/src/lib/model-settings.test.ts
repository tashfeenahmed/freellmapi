import { describe, expect, it } from 'vitest'
import {
  modelSettingsForm,
  parseOptionalCount,
  parseRank,
  reviewModelSettings,
  type ModelSettingsSource,
} from './model-settings'

const model: ModelSettingsSource = {
  displayName: 'Llama 3.3 70B',
  contextWindow: 131072,
  intelligenceRank: 42,
  speedRank: 17,
  sizeLabel: 'Large',
  rpmLimit: 30,
  rpdLimit: 1000,
  tpmLimit: null,
  tpdLimit: null,
  supportsVision: false,
  supportsTools: true,
  enabled: true,
}

describe('parseRank (#551)', () => {
  it('accepts integers inside the catalog range', () => {
    expect(parseRank('1')).toBe(1)
    expect(parseRank(' 1000 ')).toBe(1000)
  })

  it('rejects blanks, fractions and out-of-range values', () => {
    for (const input of ['', '  ', '0', '1001', '1.5', 'abc', '-3']) {
      expect(parseRank(input)).toBeUndefined()
    }
  })
})

describe('parseOptionalCount (#551)', () => {
  it('reads a blank field as "no limit"', () => {
    expect(parseOptionalCount('')).toBeNull()
    expect(parseOptionalCount('   ')).toBeNull()
  })

  it('accepts positive integers and rejects everything else', () => {
    expect(parseOptionalCount('30')).toBe(30)
    for (const input of ['0', '-1', '2.5', 'lots']) {
      expect(parseOptionalCount(input)).toBeUndefined()
    }
  })
})

describe('reviewModelSettings (#551)', () => {
  it('is clean and valid for an untouched form', () => {
    const review = reviewModelSettings(model, modelSettingsForm(model))
    expect(review.dirty).toBe(false)
    expect(Object.values(review.invalid).some(Boolean)).toBe(false)
    expect(review.patch).toEqual({})
  })

  it('sends only the edited ranks and limits, so untouched fields keep tracking the catalog', () => {
    const form = { ...modelSettingsForm(model), intelligenceRank: '3', tpmLimit: '6000' }
    const review = reviewModelSettings(model, form)
    expect(review.dirty).toBe(true)
    expect(review.patch).toEqual({ intelligenceRank: 3, tpmLimit: 6000 })
  })

  it('sends the fallback toggle under its own key', () => {
    const review = reviewModelSettings(model, { ...modelSettingsForm(model), fallbackEnabled: false })
    expect(review.patch).toEqual({ fallbackEnabled: false })
  })

  it('clears a rate limit with an explicit null when the field is emptied', () => {
    const review = reviewModelSettings(model, { ...modelSettingsForm(model), rpmLimit: '' })
    expect(review.dirty).toBe(true)
    expect(review.patch).toEqual({ rpmLimit: null })
  })

  it('blocks the save while a rank is out of range', () => {
    const review = reviewModelSettings(model, { ...modelSettingsForm(model), speedRank: '5000' })
    expect(review.invalid.speedRank).toBe(true)
    expect(review.dirty).toBe(true)
    expect(review.patch).toBeNull()
  })

  it('blocks the save on a blank rank rather than sending a null the API rejects', () => {
    const review = reviewModelSettings(model, { ...modelSettingsForm(model), intelligenceRank: '' })
    expect(review.invalid.intelligenceRank).toBe(true)
    expect(review.patch).toBeNull()
  })

  it('treats a missing tpm/tpd on the source as "no limit", not as a change', () => {
    const sparse: ModelSettingsSource = { ...model, tpmLimit: undefined, tpdLimit: undefined }
    expect(reviewModelSettings(sparse, modelSettingsForm(sparse)).dirty).toBe(false)
  })
})
