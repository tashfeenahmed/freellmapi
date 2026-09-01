import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// #801: the agent cards showed only a wire protocol and a base-URL suffix,
// which says nothing about what any of these tools actually is. The cards now
// read `agents.descriptions.<id>` and fall back to the old protocol line when
// the key is absent, so the thing worth holding here is that no catalog entry
// relies on that fallback and that the four tools people confuse — Cline, Roo,
// Kilo and Crush — are described differently from one another.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const catalog: { id: string }[] = JSON.parse(
  readFileSync(path.join(here, '../data/agent-tools.json'), 'utf8'),
)

function descriptions(locale: string): Record<string, string> {
  const json = JSON.parse(readFileSync(path.join(localeDir, `${locale}.json`), 'utf8'))
  return json.agents.descriptions ?? {}
}

describe('agent card descriptions', () => {
  it('describes every tool in the catalog', () => {
    const english = descriptions('en')
    for (const tool of catalog) {
      expect(english[tool.id], tool.id).toBeTruthy()
    }
    // No orphans either: a description for an id no longer in the catalog is
    // dead copy every locale has to carry.
    expect(Object.keys(english).sort()).toEqual(catalog.map(tool => tool.id).sort())
  })

  it('tells the four lookalike agents apart', () => {
    const english = descriptions('en')
    const lookalikes = ['cline', 'roo', 'kilo', 'crush'].map(id => english[id])
    expect(new Set(lookalikes).size).toBe(lookalikes.length)
    // Crush is Charm's terminal agent written in Go, not a VS Code extension.
    expect(english.crush).not.toMatch(/VS Code/)
  })

  it('carries the same description ids in all 60 locales', () => {
    const expected = Object.keys(descriptions('en')).sort()
    const locales = readdirSync(localeDir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -5))
    expect(locales.length).toBe(60)
    for (const locale of locales) {
      expect(Object.keys(descriptions(locale)).sort(), locale).toEqual(expected)
    }
  })
})
