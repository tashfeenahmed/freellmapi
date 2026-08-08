// ── Per-model routing weight overrides (#738) ────────────────────────────────
//
// Operators who run a relay with several models sometimes want to keep a model
// around (manual priority may still select it) while making the bandit far less
// likely to pick it — a slow, poor-quality, or just less-preferred model should
// be demoted without being disabled outright. The routing strategies only offer
// GLOBAL weight vectors (per-strategy presets or the user's 'custom' vector), so
// there was no way to single out one model.
//
// `MODEL_ROUTING_OVERRIDES` is a JSON object mapping model ids to a score
// multiplier, e.g.
//
//     MODEL_ROUTING_OVERRIDES='{"gpt-4o": 0.2, "deepseek-v3": 0.8}'
//
// The multiplier is applied to a model's bandit score AFTER combineScore:
//   1.0  → unchanged (explicit no-op)
//   <1.0 → demoted (0.0 is the extreme: never picked by the bandit, but a
//          manual 'priority' chain can still route to it — "not disabled")
//   >1.0 → promoted
// Out-of-range (negative, >2) or non-finite values are dropped, never applied;
// an empty or malformed variable is ignored entirely. Matching is by model_id
// alone (not platform-qualified), consistent with "individual models" in #738.
//
// The override is orthogonal to the strategy's weight vector: it multiplies the
// final score rather than replacing any weight, so it composes with every
// strategy (except 'priority', which has no score — the bandit branch only).

export type ModelWeightOverrides = ReadonlyMap<string, number>;

/** Overrides parsed from `MODEL_ROUTING_OVERRIDES`, cached after first read. */
let cache: ModelWeightOverrides | null = null;

/** Parse the env var. Pure and exported for tests: unknown keys are dropped,
 *  values must be finite and in [0, 2]. Returns an empty map on any malformed
 *  input (not an object, or unparsable JSON) rather than throwing. */
export function parseModelWeightOverrides(raw: string | undefined): Map<string, number> {
  if (raw === undefined || raw.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();

  const out = new Map<string, number>();
  for (const [modelId, value] of Object.entries(parsed)) {
    if (!modelId.trim()) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) continue;
    out.set(modelId, value);
  }
  return out;
}

/** The active overrides — parsed lazily from the environment on first use and
 *  cached for the life of the process (the env is fixed at boot). */
export function getModelWeightOverrides(): ModelWeightOverrides {
  if (cache === null) cache = parseModelWeightOverrides(process.env.MODEL_ROUTING_OVERRIDES);
  return cache;
}

/** Test seam: forget the cached parse so a changed env var takes effect. */
export function resetModelWeightOverrides(): void {
  cache = null;
}

/** Apply a model's override to a bandit score. `overrides` is injectable for
 *  tests; it defaults to the process-wide parsed map. */
export function applyModelWeightOverride(
  score: number,
  modelId: string,
  overrides: ModelWeightOverrides = getModelWeightOverrides(),
): number {
  const override = overrides.get(modelId);
  return override === undefined ? score : score * override;
}
