// Filtering helpers for the Fusion panel model picker (issue #872).
// The explicit panel can list hundreds of models once several providers are
// connected, so it needs a search box plus a provider filter instead of an
// unscrollable wall of rows. Pure functions so the UI stays thin and the
// matching rules are unit-testable.

import type { ModelOption } from './model-groups'

/**
 * Match a model option against a free-text query (case-insensitive substring
 * over name, canonical id, and every provider name) and an optional provider
 * filter. A null/empty provider means "all providers".
 */
export function filterFusionModels(
  options: ModelOption[],
  query: string,
  provider: string | null,
): ModelOption[] {
  const q = query.trim().toLowerCase()
  return options.filter(o => {
    if (provider && !(o.platform === provider || o.platforms.includes(provider))) {
      return false
    }
    if (!q) return true
    const haystack = `${o.label} ${o.value} ${o.platform} ${o.platforms.join(' ')}`.toLowerCase()
    return haystack.includes(q)
  })
}

/** Distinct provider names across the options, sorted for a stable Select list. */
export function fusionProviders(options: ModelOption[]): string[] {
  const seen = new Set<string>()
  for (const o of options) {
    seen.add(o.platform)
    for (const p of o.platforms) seen.add(p)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}
