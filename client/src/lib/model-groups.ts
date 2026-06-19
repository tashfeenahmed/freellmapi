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
}

export interface ModelOption {
  value: string        // what to send as `model`: canonicalId (ON) or model_id (OFF)
  label: string
  platform: string     // meaningful when providerCount === 1
  providerCount: number
}

export function buildModelOptions(entries: PickerEntry[], unifyOn: boolean): ModelOption[] {
  if (!unifyOn) {
    return entries.map(e => ({ value: e.modelId, label: e.displayName, platform: e.platform, providerCount: 1 }))
  }
  // Group by groupKey (falling back to model_id for ungrouped rows), preserving
  // first-seen order so the list still respects the server's ordering.
  const groups = new Map<string, ModelOption>()
  for (const e of entries) {
    const key = e.groupKey ?? e.modelId
    const existing = groups.get(key)
    if (existing) existing.providerCount++
    else groups.set(key, { value: e.canonicalId ?? e.modelId, label: e.groupLabel ?? e.displayName, platform: e.platform, providerCount: 1 })
  }
  return [...groups.values()]
}
