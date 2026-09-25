import type { Model } from '@freellmapi/shared/types'

// Pure helpers behind the Keys page's "Test models" dialog, kept out of the
// component file so fast refresh sees only components there.

/** Client-side guard matching the server's per-model throttle window, so a
 *  double click reads as "wait" instead of a 429 toast. */
export const MODEL_TEST_MIN_INTERVAL_MS = 5_000

/** Wall clock behind the throttle; a function so components stay pure under
 *  the react-hooks/purity rule and tests can stub it. */
export const nowMs = (): number => Date.now()

/** The models the dialog should list, smartest first. Exported for tests. */
export function selectTestableModels(models: readonly Model[], platform: string, keyId?: number | null): Model[] {
  return models
    .filter(m => m.platform === platform && (keyId == null || m.keyId === keyId))
    .sort((a, b) => a.intelligenceRank - b.intelligenceRank || a.displayName.localeCompare(b.displayName))
}
