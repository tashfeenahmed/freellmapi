import { describe, expect, it } from 'vitest'
import { entryScriptSrc, isNewBuild } from './new-build'

const page = (src: string) => `<!doctype html><html><head><script>/* theme bootstrap */</script>
<script type="module" crossorigin src="${src}"></script><link rel="stylesheet" href="/assets/index-a.css"></head></html>`

describe('new build detection', () => {
  it('reads the module entry script, whatever the attribute order', () => {
    expect(entryScriptSrc(page('/assets/index-Ab12.js'))).toBe('/assets/index-Ab12.js')
    expect(entryScriptSrc('<script src="/assets/index-Cd34.js" type="module"></script>')).toBe('/assets/index-Cd34.js')
    expect(entryScriptSrc('<script>inline()</script>')).toBeNull()
  })

  it('reports a new build only when the fingerprinted entry changed', () => {
    expect(isNewBuild('/assets/index-Ab12.js', page('/assets/index-Ab12.js'))).toBe(false)
    expect(isNewBuild('http://127.0.0.1:3001/assets/index-Ab12.js', page('/assets/index-Ef56.js'))).toBe(true)
  })

  it('never fires on a dev server or an unreadable page', () => {
    expect(isNewBuild('/src/main.tsx', page('/src/main.tsx?t=2'))).toBe(false)
    expect(isNewBuild(null, page('/assets/index-Ef56.js'))).toBe(false)
    expect(isNewBuild('/assets/index-Ab12.js', '<html>502 Bad Gateway</html>')).toBe(false)
  })
})
