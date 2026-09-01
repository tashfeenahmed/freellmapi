// Pure logic behind the post-add model picker on the Keys page.
//
// A freshly pasted provider key serves EVERY model of its platform (#657:
// `model_scope_json` NULL = no scope). That is right for most people and wrong
// for anyone holding a relay-station key that only pays for a couple of model
// groups — and the only way to find out used to be a stream of 401s at routing
// time. So the moment a key lands for a platform with a big catalog, offer the
// list once.
//
// The two rules that make the offer safe to accept:
//   * "everything ticked" must stay a NULL scope, never the full id list.
//     A stored list freezes the key at today's catalog, so every model the
//     catalog gains next month would silently bypass that key.
//   * "nothing ticked" is not a scope. The server maps an empty array back to
//     NULL (= serves everything), which is the exact opposite of what an empty
//     tick list looks like it means, so the caller must refuse to submit it
//     rather than send a request that quietly does the wrong thing.
//
// Kept out of the component so both rules are unit-testable without rendering.

import type { FallbackEntry } from './routing'

/** One row of the picker: a catalog model this key could be scoped to. */
export interface ScopeCandidate {
  /** The provider-side model id — what `modelScope` actually stores. */
  modelId: string
  displayName: string
  /** Catalog capability tier ('Frontier' | 'Large' | 'Medium' | 'Small'), or null. */
  sizeLabel: string | null
  contextWindow: number | null
}

/**
 * Below this many models the picker is pure friction: a provider serving three
 * models is trivially inspected on the Models page, and a dialog in the way of
 * "I just pasted a key" costs more than it saves. Six = "more than five".
 */
export const MODEL_PICKER_MIN_MODELS = 6

/**
 * The picker rows for one platform, taken from the `['fallback']` model list
 * the dashboard already holds — no extra endpoint, and no widening of the
 * POST /api/keys response.
 *
 * Order is left exactly as the server sent it (fallback priority, i.e. roughly
 * best-first), so the picker reads like the Models table rather than inventing
 * its own ranking. Duplicate model ids collapse to their first occurrence:
 * `modelScope` matches on model id alone, so two rows with one id could never
 * be ticked apart.
 */
export function scopeCandidates(
  entries: readonly FallbackEntry[],
  platform: string,
): ScopeCandidate[] {
  // 'custom' rows are per-endpoint, not per-platform — one custom key must
  // never be offered another endpoint's models.
  if (!platform || platform === 'custom') return []
  const seen = new Set<string>()
  const candidates: ScopeCandidate[] = []
  for (const entry of entries) {
    if (entry.platform !== platform) continue
    if (!entry.modelId || seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    candidates.push({
      modelId: entry.modelId,
      displayName: entry.displayName || entry.modelId,
      sizeLabel: entry.sizeLabel || null,
      contextWindow: entry.contextWindow ?? null,
    })
  }
  return candidates
}

/** Whether a just-added key on this platform is worth interrupting for. */
export function shouldOfferModelPicker(candidates: readonly ScopeCandidate[]): boolean {
  return candidates.length >= MODEL_PICKER_MIN_MODELS
}

/**
 * What confirming the picker should do.
 *
 * `patch: false` means "send nothing at all" — either every model is ticked
 * (the key already serves everything, and leaving the scope NULL keeps future
 * catalog additions flowing through it) or nothing is ticked (not expressible;
 * the caller disables Confirm, and this is the belt-and-braces half).
 */
export type ScopeUpdate =
  | { patch: false; reason: 'all' | 'empty' }
  | { patch: true; modelScope: string[] }

export function resolveScopeUpdate(
  allIds: readonly string[],
  selected: ReadonlySet<string>,
): ScopeUpdate {
  // Driven by `allIds`, not by the set: a tick left over from an id that is no
  // longer on offer must not end up in the saved scope, and must not inflate
  // the count that decides "is this everything?".
  const chosen = allIds.filter(id => selected.has(id))
  if (chosen.length === 0) return { patch: false, reason: 'empty' }
  if (chosen.length === allIds.length) return { patch: false, reason: 'all' }
  return { patch: true, modelScope: chosen }
}
