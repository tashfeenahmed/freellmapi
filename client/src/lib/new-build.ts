// Vite fingerprints the entry bundle (/assets/index-<hash>.js) and the server
// sends index.html with no-cache, so the entry <script> in a fresh copy of
// index.html names the build the server is serving now. A tab whose own entry
// script differs is running a build that has since been replaced — after a
// Docker pull, a source rebuild or a desktop update — and its lazy chunks may
// already be gone from disk.

const ENTRY_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']|<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/i

/** The entry script this tab is running, or null outside a browser. */
export function loadedEntryScript(): string | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null
}

/** Fetches this server's current index.html, uncached. Throws while it is down. */
export async function fetchLatestIndex(): Promise<string> {
  const response = await fetch(import.meta.env.BASE_URL, { cache: 'no-store', headers: { Accept: 'text/html' } })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/** The module entry script an index.html loads, or null when it has none. */
export function entryScriptSrc(html: string): string | null {
  const match = ENTRY_SCRIPT.exec(html)
  const src = match?.[1] ?? match?.[2]
  return src ? new URL(src, 'http://x/').pathname : null
}

/**
 * True when `latestHtml` loads a different fingerprinted entry than the one
 * this tab loaded. Dev servers (no /assets/ fingerprint) never report one.
 */
export function isNewBuild(loadedSrc: string | null, latestHtml: string): boolean {
  if (!loadedSrc || !loadedSrc.includes('/assets/')) return false
  const latest = entryScriptSrc(latestHtml)
  return latest != null && latest.includes('/assets/') && latest !== new URL(loadedSrc, 'http://x/').pathname
}
