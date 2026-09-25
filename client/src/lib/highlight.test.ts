import { describe, it, expect } from 'vitest'
import { escapeHtml, highlightCode, resolveLanguage } from './highlight'

describe('resolveLanguage', () => {
  it('maps the tags models write onto registered grammars', () => {
    expect(resolveLanguage('html')).toBe('xml')
    expect(resolveLanguage('svg')).toBe('xml')
    expect(resolveLanguage('JS')).toBe('javascript')
    expect(resolveLanguage('tsx')).toBe('typescript')
    expect(resolveLanguage('py')).toBe('python')
    expect(resolveLanguage('sh')).toBe('bash')
    expect(resolveLanguage('yml')).toBe('yaml')
  })
  it('returns null for nothing and for grammars we do not ship', () => {
    expect(resolveLanguage('')).toBeNull()
    expect(resolveLanguage(undefined)).toBeNull()
    expect(resolveLanguage('brainfuck')).toBeNull()
  })
})

describe('highlightCode', () => {
  it('marks up html with tag and attribute spans and keeps the text escaped', () => {
    const out = highlightCode('<div class="a">x &amp; y</div>', 'html')
    expect(out.language).toBe('xml')
    expect(out.html).toContain('hljs-tag')
    expect(out.html).toContain('hljs-attr')
    expect(out.html).not.toContain('<div class="a">')       // real tags never leak through
    expect(out.html).toContain('&lt;')
  })
  it('highlights javascript keywords and strings', () => {
    const out = highlightCode("const x = 'hi'; function f() { return 1 }", 'js')
    expect(out.language).toBe('javascript')
    expect(out.html).toContain('hljs-keyword')
    expect(out.html).toContain('hljs-string')
  })
  it('auto-detects an untagged block when the signal is strong', () => {
    const out = highlightCode('def greet(name):\n    print(f"hello {name}")\n\nfor i in range(3):\n    greet(i)\n', null)
    expect(out.language).toBe('python')
  })
  it('falls back to plain escaped text rather than a wrong grammar', () => {
    const out = highlightCode('just a sentence <with> a bracket', 'brainfuck')
    expect(out.html).toBe('just a sentence &lt;with&gt; a bracket')
  })
})

describe('escapeHtml', () => {
  it('escapes the three characters that matter for innerHTML', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })
})
