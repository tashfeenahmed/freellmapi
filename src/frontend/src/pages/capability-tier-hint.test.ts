import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// #891: the capability-tier tooltip claimed an unrecognized tier "scores 0" and
// is "never auto-routed". tierValue does floor an unknown label at 0, but that
// is one term of a weighted sum — combineScore gives intelligence 0.25 under
// the default preset — so no model is ever excluded from routing, and custom
// models are deliberately seeded at the catalog median tier so they route
// (custom-model-seed.ts, #488). The reworded tooltip drops the score claim
// entirely, which is also what makes a stale locale detectable here: every
// pre-#891 translation carried that literal "0" and none of the current ones
// do. The first fix shipped in six locales only; these tests hold all 60.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const scoring = readFileSync(
  path.join(here, '../../../server/src/services/scoring.ts'),
  'utf8',
)

const KEYS = ['sizeLabelHint', 'sizeLabelNone'] as const

function models(locale: string): Record<string, string> {
  const json = JSON.parse(readFileSync(path.join(localeDir, `${locale}.json`), 'utf8'))
  return json.models as Record<string, string>
}

const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

const english = models('en')

describe('capability-tier hint', () => {
  it('leaves intelligence as one weighted axis, not a routing veto', () => {
    // The premise the wording rests on. If a hard exclusion for untiered models
    // is ever added, this fails and the tooltip gets revisited with it.
    expect(scoring).toContain('export function combineScore')
    expect(scoring).toMatch(/balanced: \{ reliability: 0\.5, speed: 0\.25, intelligence: 0\.25 \}/)
    expect(scoring).not.toMatch(/can never win an auto-route/)
  })

  it('never tells the user a tier-less model scores 0 or cannot be routed', () => {
    for (const locale of locales) {
      const strings = models(locale)
      for (const key of KEYS) {
        // The digit is the tell: every pre-#891 translation of these two
        // strings quoted the "0" score, and no correct one needs a number.
        expect(strings[key], `${locale}.${key} still quotes the 0 score`)
          .not.toContain('0')
        expect(strings[key], `${locale}.${key} still promises "never"`)
          .not.toMatch(/never/i)
      }
    }
  })

  it('translates both strings in every locale, distinct from the English source', () => {
    expect(locales.length).toBeGreaterThan(50)
    for (const locale of locales) {
      const strings = models(locale)
      for (const key of KEYS) {
        const value = strings[key]
        expect(value, `${locale}.${key}`).toBeTruthy()
        // The tier names stay in Latin in every locale — they are the values
        // the picker shows — so an untranslated string is not merely "contains
        // English", it is byte-identical to en.json.
        if (locale !== 'en') {
          expect(value, `${locale}.${key} is still the English string`)
            .not.toBe(english[key])
        }
      }
      // The hint explains the axis; the placeholder names one option. A locale
      // that pasted one into the other explains nothing.
      expect(strings.sizeLabelHint, `${locale} reuses one string for both`)
        .not.toBe(strings.sizeLabelNone)
    }
  })
})
