// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ApiKey } from '../../../../shared/types'
import { keyMatchesQuery } from './provider-list'

// The keys-page search box must be able to reach every string the row
// renders. A custom endpoint row prints its baseUrl; before this the filter
// only knew label and masked key, so searching a relay's host — the one
// identifier visible for a keyless relay with no label — found nothing,
// which is exactly what #1056 fixed for the fallback table.

const key = (over: Partial<ApiKey> = {}) =>
  ({ id: 1, platform: 'custom', label: null, maskedKey: '****abcd', baseUrl: 'https://api.unorouter.com/v1', ...over }) as ApiKey

describe('keyMatchesQuery (#1056 applied to /keys)', () => {
  it('matches the endpoint host the row displays', () => {
    expect(keyMatchesQuery(key(), 'unorouter')).toBe(true)
    expect(keyMatchesQuery(key(), 'API.UnoRouter.com')).toBe(true)
  })

  it('still matches the label and masked key', () => {
    expect(keyMatchesQuery(key({ label: 'Work relay' }), 'work')).toBe(true)
    expect(keyMatchesQuery(key(), 'abcd')).toBe(true)
  })

  it('misses an unrelated query', () => {
    expect(keyMatchesQuery(key(), 'groq')).toBe(false)
  })

  it('tolerates a missing label and baseUrl', () => {
    expect(() => keyMatchesQuery(key({ label: undefined, baseUrl: undefined }), 'groq')).not.toThrow()
    expect(keyMatchesQuery(key({ label: undefined, baseUrl: undefined }), 'groq')).toBe(false)
  })
})
