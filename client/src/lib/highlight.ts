import hljs from 'highlight.js/lib/core'
import xml from 'highlight.js/lib/languages/xml'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import markdown from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'

// Syntax highlighting for code the Playground shows: reply code blocks and
// the artifact panel's Code tab. highlight.js core with a hand-picked set of
// grammars (the whole library is ~1 MB; these fourteen cover what chat models
// actually emit). Output is escaped HTML with `hljs-*` spans, coloured by the
// token rules in index.css so it follows the dashboard's light/dark tokens.

hljs.registerLanguage('xml', xml)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)

// Fence tags models write → registered grammar names.
const ALIASES: Record<string, string> = {
  html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', vue: 'xml',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  scss: 'css', less: 'css',
  jsonc: 'json', json5: 'json',
  py: 'python', python3: 'python',
  sh: 'bash', zsh: 'bash', console: 'shell', shellsession: 'shell',
  md: 'markdown', yml: 'yaml', golang: 'go', rs: 'rust',
}

export interface Highlighted {
  /** Escaped HTML with `hljs-*` spans — safe to inject as innerHTML. */
  html: string
  /** The grammar that was applied, or null when the code is plain escaped text. */
  language: string | null
}

export function resolveLanguage(tag: string | null | undefined): string | null {
  const lower = (tag ?? '').trim().toLowerCase()
  if (!lower) return null
  const name = ALIASES[lower] ?? lower
  return hljs.getLanguage(name) ? name : null
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Highlight with the tagged grammar; an unknown or missing tag falls back to
 *  auto-detection over the registered set, and anything hljs cannot place is
 *  returned escaped, never styled wrong. */
export function highlightCode(code: string, tag?: string | null): Highlighted {
  const language = resolveLanguage(tag)
  try {
    if (language) return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language }
    if (code.length <= 20_000) {
      const auto = hljs.highlightAuto(code)
      if (auto.language && auto.relevance >= 5) return { html: auto.value, language: auto.language }
    }
  } catch {
    // fall through to plain text
  }
  return { html: escapeHtml(code), language: null }
}
