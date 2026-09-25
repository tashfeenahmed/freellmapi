import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The Playground only scrolls inside its transcript pane if every ancestor
// between <body> and that pane carries a definite height. One unconditional
// `min-h-screen` on the shell breaks it: min-height is a floor, not a ceiling,
// so the shell grows with the chat and the document scrolls instead. The
// contract lives in a couple of class strings in App.tsx
// and regresses silently, so it is pinned here like the chain manager pins
// its routing.
const here = path.dirname(fileURLToPath(import.meta.url))
const app = readFileSync(path.join(here, 'App.tsx'), 'utf8')
const playground = readFileSync(path.join(here, 'pages/PlaygroundPage.tsx'), 'utf8')

describe('app shell heights', () => {
  it('pins full-bleed routes to the viewport, padded routes to the document', () => {
    // h-dvh gives the shell a definite height so the flex chain below can
    // constrain the transcript; overflow-hidden stops the document itself
    // from scrolling. Padded routes keep plain min-height and scroll as a
    // document — clipping them under h-dvh would leave long pages with no
    // scrollbar at all.
    expect(app).toMatch(/fullBleed \? 'h-dvh overflow-hidden' : 'min-h-screen min-w-0 max-w-full overflow-x-hidden'/)
  })

  it('passes a definite height down the flex chain to the page', () => {
    // Dropping min-h-0/flex-1 anywhere between the shell and the page lets
    // the content size its ancestors again, which is the original bug by
    // another route.
    expect(app).toContain("'flex min-h-0 flex-1 flex-col'")
    expect(playground).toContain('flex min-h-0 flex-1 overflow-hidden')
  })

  it('keeps /playground in the full-bleed set', () => {
    expect(app).toMatch(/FULL_BLEED_ROUTES = new Set\(\[[^\]]*'\/playground'[^\]]*\]\)/)
  })
})
