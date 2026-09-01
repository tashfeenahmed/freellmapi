import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// #870: RPM/RPD/TPM/TPD were bare acronyms sharing one generic hint
// ("Leave blank for no limit."), so nothing on screen said what they stood
// for. Each field now carries its own tooltip that spells the acronym out.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const source = readFileSync(path.join(here, 'ModelDetailPage.tsx'), 'utf8')

const FIELDS = ['Rpm', 'Rpd', 'Tpm', 'Tpd'] as const

function models(locale: string): Record<string, string> {
  const json = JSON.parse(readFileSync(path.join(localeDir, `${locale}.json`), 'utf8'))
  return json.models as Record<string, string>
}

const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

describe('rate-limit field hints', () => {
  it('gives every limit field its own hint rather than the shared one', () => {
    for (const field of FIELDS) {
      // The label and the hint must be the matching pair, not RPM labelled
      // with the TPD explanation.
      expect(source).toContain(`label={t('models.limit${field}')}`)
      expect(source).toContain(`hint={t('models.limit${field}Hint')}`)
    }
    // The generic hint these replaced is gone from the page.
    expect(source).not.toContain("t('models.limitHint')")
  })

  it('translates all four hints in every locale, and keeps them distinct', () => {
    expect(locales.length).toBeGreaterThan(50)
    for (const locale of locales) {
      const strings = models(locale)
      const values = FIELDS.map(field => strings[`limit${field}Hint`])
      for (const [i, value] of values.entries()) {
        expect(value, `${locale}.limit${FIELDS[i]}Hint`).toBeTruthy()
      }
      // A locale that pasted the same sentence four times explains nothing, so
      // reject that outright: minute and day, requests and tokens, all differ.
      expect(new Set(values).size, `${locale} reuses one hint for several fields`).toBe(4)
      // The retired key must not linger anywhere.
      expect(strings.limitHint, `${locale} still carries the retired limitHint`).toBeUndefined()
    }
  })
})
