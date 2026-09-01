import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The chain manager is the dashboard surface for named fallback chains
// (#960/#895). Two things about it are easy to break by accident and are
// pinned here: every string it renders has to exist in all 60 locales, and it
// has to stay a secondary panel on the Fallback page rather than growing into
// its own nav entry — one chain is all most installs ever use.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const source = readFileSync(path.join(here, 'chain-manager.tsx'), 'utf8')
const fallbackPage = readFileSync(path.join(here, '../pages/FallbackPage.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')
const playground = readFileSync(path.join(here, '../pages/PlaygroundPage.tsx'), 'utf8')

function locale(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(localeDir, `${name}.json`), 'utf8'))
}

function lookup(dictionary: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    dictionary,
  )
}

const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

// Every t('...') the component actually calls.
const usedKeys = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])

describe('chain manager', () => {
  it('calls only keys that exist in every locale', () => {
    expect(usedKeys.length).toBeGreaterThan(5)
    expect(usedKeys).toContain('chains.title')
    expect(locales.length).toBeGreaterThan(50)

    for (const name of locales) {
      const dictionary = locale(name)
      for (const key of usedKeys) {
        expect(typeof lookup(dictionary, key), `${name} is missing ${key}`).toBe('string')
      }
    }
  })

  it('keeps the {name} and {count} placeholders in every locale', () => {
    for (const name of locales) {
      const dictionary = locale(name)
      expect(lookup(dictionary, 'chains.deleteConfirm'), `${name}.chains.deleteConfirm`)
        .toContain('{name}')
      expect(lookup(dictionary, 'chains.count'), `${name}.chains.count`).toContain('{count}')
    }
  })

  it('lives on the Fallback page as a collapsible panel, not a nav entry', () => {
    expect(fallbackPage).toContain("import { ChainManager } from '@/components/chain-manager'")
    expect(fallbackPage).toContain('<ChainManager />')
    // Collapsed by default and remembered per browser, like the penalty
    // inspector next to it — the routing table is what the page is for.
    expect(source).toContain('aria-expanded')
    expect(source).toMatch(/stored === null \? true : stored === '1'/)
    // No route or nav destination of its own.
    expect(app).not.toContain('chain-manager')
    expect(app).not.toContain('ChainManager')
  })

  it('surfaces the server error when a chain name is rejected', () => {
    // POST /api/profiles enforces length, character set, reserved words and
    // uniqueness. Swallowing that 400/409 leaves a button that does nothing.
    expect(source).toContain('onError')
    expect(source).toContain('setCreateError')
  })
})

// Switching the active chain has to change what the rest of the dashboard is
// looking at (#1021). Both of these were silently wrong: the routing table read
// one unscoped cache entry, so a switch re-rendered the previous chain's rows
// and a save wrote them into the new chain; and the Playground could only ever
// send 'auto', so a chain you had just built was untestable from the dashboard.
describe('chains reach the rest of the dashboard (#1021)', () => {
  it('scopes the fallback table and its staged edits to the active chain', () => {
    expect(fallbackPage).toContain("queryKey: ['profiles', 'active']")
    expect(fallbackPage).toContain("queryKey: ['fallback', 'chain', activeProfileId]")
    // Staged edits remember which chain they were made against instead of
    // following whichever one happens to be active at save time.
    expect(fallbackPage).toMatch(/staged\.profileId === activeProfileId/)
  })

  it('offers every custom chain in the playground picker as auto:<name>', () => {
    expect(playground).toContain("queryKey: ['profiles']")
    // The id has to be derived exactly as the server derives it in
    // routes/proxy.ts, or the picker offers models /v1/models never listed.
    expect(playground).toContain('`auto:${c.name.toLowerCase()}`')
    expect(playground).toContain('...chainOptions,')
    // A chain is server-picked like plain auto, so the "can't see images" hint
    // must not fire on one.
    expect(playground).toContain("!selectedModel.startsWith('auto:')")
  })
})
