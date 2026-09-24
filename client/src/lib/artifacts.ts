// Artifacts: runnable code a reply carries, shown in a side panel with a live
// preview next to the source — the pattern Claude's Artifacts panel made
// familiar (a sandboxed iframe for the preview, tabs for code and preview,
// copy and download in the header). This module is the pure half: finding the
// artifacts in a Markdown reply and building the document the iframe runs.

export type ArtifactKind = 'html' | 'svg'

export interface Artifact {
  /** Stable within a message: `${messageIndex}:${blockIndex}`. */
  id: string
  kind: ArtifactKind
  /** Fence language as written, lowercased ('' when the fence had none). */
  language: string
  code: string
  /** <title> / <svg title> when present, else a kind label chosen by the caller. */
  title: string | null
  filename: string
}

const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)\n[ \t]{0,3}\2[ \t]*$/gm

/** Is this fenced block something a browser can run on its own? */
export function artifactKindOf(language: string, code: string): ArtifactKind | null {
  const lang = language.toLowerCase()
  const head = code.slice(0, 400).trimStart().toLowerCase()
  if (lang === 'svg' || (head.startsWith('<svg') && (lang === '' || lang === 'xml' || lang === 'html'))) return 'svg'
  if (lang === 'html' || lang === 'htm' || lang === 'xhtml') return 'html'
  if ((lang === '' || lang === 'xml' || lang === 'markup') && (head.startsWith('<!doctype html') || head.startsWith('<html'))) return 'html'
  return null
}

function titleOf(kind: ArtifactKind, code: string): string | null {
  const m = kind === 'html'
    ? /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)
    : /<title[^>]*>([^<]{1,120})<\/title>/i.exec(code)
  const t = m?.[1]?.trim()
  return t ? t : null
}

/** Every runnable fenced block in a Markdown reply, in document order.
 *  A fence still open (streaming) is not matched, so a card only appears
 *  once the block has closed. */
export function extractArtifacts(markdown: string, messageIndex = 0): Artifact[] {
  const out: Artifact[] = []
  let block = 0
  for (const m of markdown.matchAll(FENCE)) {
    const language = (m[3] ?? '').toLowerCase()
    const code = m[4] ?? ''
    block += 1
    const kind = artifactKindOf(language, code)
    if (!kind) continue
    out.push({
      id: `${messageIndex}:${block}`,
      kind,
      language,
      code,
      title: titleOf(kind, code),
      filename: kind === 'svg' ? `artifact-${block}.svg` : `artifact-${block}.html`,
    })
  }
  return out
}

/** The document the sandboxed iframe runs. HTML is passed through as the
 *  model wrote it; an SVG is centred on a neutral page so it is visible at
 *  its natural size. */
export function artifactSrcDoc(artifact: Artifact): string {
  if (artifact.kind === 'html') return artifact.code
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%}</style></head><body>${artifact.code}</body></html>`
}

/** Sandbox flags for the preview: scripts may run (a page without JS is not
 *  much of a preview) but the frame is a separate origin with no access to
 *  the dashboard, its storage or its session. Never add allow-same-origin. */
export const ARTIFACT_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock'

export function artifactMimeType(kind: ArtifactKind): string {
  return kind === 'svg' ? 'image/svg+xml' : 'text/html'
}
