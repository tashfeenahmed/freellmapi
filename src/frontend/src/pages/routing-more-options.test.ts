import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The Routing strategy card opens on the strategy pills and nothing else. The
// secondary knobs added since (key selection, exploration, peak hours) sit
// behind a "More options" disclosure on the right of the pill row. This pins
// that layout: the knobs are easy to drag back out into the open by accident,
// and the "(peak hours)" marker on the weight summary must stay out of the
// disclosure because it explains what routing is doing right now.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const page = readFileSync(path.join(here, 'FallbackPage.tsx'), 'utf8')

const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

const disclosureStart = page.indexOf('{!optionsCollapsed && (')

describe('routing strategy "More options" disclosure', () => {
  it('has its label in every locale', () => {
    expect(locales.length).toBeGreaterThan(50)
    for (const name of locales) {
      const dictionary = JSON.parse(readFileSync(path.join(localeDir, `${name}.json`), 'utf8'))
      expect(typeof dictionary.strategies.moreOptions, `${name} is missing strategies.moreOptions`)
        .toBe('string')
    }
  })

  it('is collapsed by default and remembered per browser', () => {
    expect(page).toContain("const OPTIONS_COLLAPSED_KEY = 'freellmapi.routingMoreOptions.collapsed'")
    // Same shape as the chain manager and the penalty inspector below it.
    expect(page).toMatch(/stored === null \? true : stored === '1'/)
    expect(page).toContain('localStorage.setItem(OPTIONS_COLLAPSED_KEY')
    expect(page).toContain('aria-expanded={!optionsCollapsed}')
  })

  it('hides key selection, exploration and peak hours behind the toggle', () => {
    expect(disclosureStart).toBeGreaterThan(0)
    for (const marker of [
      "t('strategies.keySelection')",
      "t('strategies.explore')",
      '<PeakHoursControls',
    ]) {
      const at = page.indexOf(marker)
      expect(at, `${marker} should be rendered`).toBeGreaterThan(0)
      expect(at, `${marker} should sit inside the disclosure`).toBeGreaterThan(disclosureStart)
      expect(page.indexOf(marker, at + 1), `${marker} should be rendered once`).toBe(-1)
    }
  })

  it('keeps the (peak hours) marker on the weight summary visible when collapsed', () => {
    const at = page.indexOf("t('strategies.peakActive')")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(disclosureStart)
  })

  it('puts the toggle on the strategy pill row', () => {
    expect(page).toContain('<div className="flex flex-wrap items-center justify-between gap-3">')
    expect(page).toContain("{t('strategies.moreOptions')}")
    expect(page).toContain('<ChevronDown')
  })
})
