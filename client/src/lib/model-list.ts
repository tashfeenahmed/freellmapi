/**
 * Split a free-text model field (used by the "Add custom provider" form) on
 * commas / newlines into a clean id list — dropping blanks and duplicates so
 * one endpoint can take several models. (#281)
 *
 * Extracted from KeysPage so it can be unit-tested in isolation.
 */
export function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}
