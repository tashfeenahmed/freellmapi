// Client-side helper for the "unify duplicate models" feature. The server sends
// each fallback entry tagged with its logical-model group (groupKey /
// canonicalId / groupLabel). When unification is ON, model pickers should show
// ONE option per group (value = canonicalId, which the proxy resolves to the
// whole group); when OFF, one option per provider row (value = model_id), as
// before. FallbackPage does its own richer grouping (it needs the members to
// render expandable rows) — this helper is just for the flat picker case.

export interface PickerEntry {
  modelDbId: number
  modelId: string
  displayName: string
  platform: string
  groupKey?: string
  canonicalId?: string
  groupLabel?: string
  intelligenceRank?: number
  sizeLabel?: string
}

export interface ModelOption {
  value: string        // what to send as `model`: canonicalId (ON) or model_id (OFF)
  label: string
  platform: string     // meaningful when providerCount === 1
  platforms: string[]  // every provider serving this model (for the "N providers" affordance)
  providerCount: number
  // Sort axes for "by intelligence": the catalog's intelligence_rank is per-
  // provider, not global (issue #135), so the dashboard orders by size tier
  // first, then rank within the tier — mirroring the server's intelligence
  // preset. For a group these hold the BEST (most capable) member's values.
  sizeTier: number     // Frontier=1, Large=2, Medium=3, Small=4, unknown=5
  intelligenceRank: number
}

const SIZE_TIER: Record<string, number> = { Frontier: 1, Large: 2, Medium: 3, Small: 4 }
export function sizeTier(label?: string): number {
  return SIZE_TIER[label ?? ''] ?? 5
}

export function buildModelOptions(entries: PickerEntry[], unifyOn: boolean): ModelOption[] {
  if (!unifyOn) {
    return entries.map(e => ({
      value: e.modelId, label: e.displayName, platform: e.platform,
      platforms: [e.platform], providerCount: 1,
      sizeTier: sizeTier(e.sizeLabel), intelligenceRank: e.intelligenceRank ?? 999,
    }))
  }
  // Group by groupKey (falling back to model_id for ungrouped rows), preserving
  // first-seen order so the list still respects the server's ordering. Within a
  // group, keep the best member's (tier, rank) so "sort by intelligence" ranks
  // the group by its most capable provider, and collect every provider name.
  const groups = new Map<string, ModelOption>()
  for (const e of entries) {
    const key = e.groupKey ?? e.modelId
    const tier = sizeTier(e.sizeLabel)
    const rank = e.intelligenceRank ?? 999
    const existing = groups.get(key)
    if (existing) {
      existing.providerCount++
      existing.platforms.push(e.platform)
      if (tier < existing.sizeTier || (tier === existing.sizeTier && rank < existing.intelligenceRank)) {
        existing.sizeTier = tier
        existing.intelligenceRank = rank
      }
    } else {
      groups.set(key, {
        value: e.canonicalId ?? e.modelId, label: e.groupLabel ?? e.displayName,
        platform: e.platform, platforms: [e.platform], providerCount: 1,
        sizeTier: tier, intelligenceRank: rank,
      })
    }
  }
  return [...groups.values()]
}
