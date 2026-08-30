// Resolving a model id against the catalog, for the launchers.
//
// The subtlety this module exists for: `catalog()` fetches `/v1/models` with
// `?available=true`, so a model missing from that response has TWO possible
// meanings — it does not exist, or it exists and is merely out of quota right
// now. Treating absence as "unknown model" reports a healthy pinned model as a
// typo the moment its provider hits a rate limit. Only the UNFILTERED roster
// can tell those apart, so `--model` is validated against that.

import type { CatalogModel } from './types.js';

export interface ResolvedModel {
  id: string;
  /** Context window in tokens, or undefined when the catalog does not publish
   *  one. Undefined is a fact — an unpublished window is not the same as a
   *  known 128k, and callers must not invent one. */
  contextWindow?: number;
  /** The catalog lists this model but it is not currently servable. */
  unavailable: boolean;
}

export class UnknownModelError extends Error {}

export function contextWindowOf(model: CatalogModel): number | undefined {
  return model.context_window ?? model.context_length ?? undefined;
}

/**
 * The launcher's default when the caller did not pin one: the first servable
 * concrete model, falling back to `auto`.
 *
 * Deliberately NOT the same default as the setup generators, which prefer
 * `auto`. A generated config file is long-lived and should let the router
 * choose per request; a launch pins one id into ANTHROPIC_MODEL for the whole
 * session, and naming a concrete model there is what makes the session's model
 * visible and reproducible. Unifying the two silently changes what
 * `freellmapi launch` runs.
 */
export function defaultModelId(models: CatalogModel[]): string {
  return models.find(model => model.id !== 'auto' && model.available !== false)?.id ?? 'auto';
}

/**
 * Resolve the model a launcher should pin.
 *
 * `available` is the filtered roster the CLI already fetches; `full` is the
 * unfiltered one. Pass the same array twice only when the unfiltered roster
 * could not be fetched — the caller then loses the ability to distinguish an
 * unknown id from an unavailable one, which is exactly the ambiguity this
 * function exists to remove.
 */
export function resolveLaunchModel(
  requested: string | undefined,
  available: CatalogModel[],
  full: CatalogModel[] = available,
): ResolvedModel {
  const id = requested ?? defaultModelId(available);
  const known = full.find(model => model.id === id) ?? available.find(model => model.id === id);

  if (!known) {
    // `auto` is served by the router itself and need not appear in any roster.
    if (id === 'auto') return { id, unavailable: false };
    const suggestions = full
      .map(model => model.id)
      .filter(candidate => candidate.includes(id) || id.includes(candidate))
      .slice(0, 5);
    throw new UnknownModelError(
      `No model '${id}' in this gateway's catalog.`
      + (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '')
      + ' Run `freellmapi list-models` to see what is registered.',
    );
  }

  return {
    id,
    contextWindow: contextWindowOf(known),
    // Absent from the filtered roster but present in the full one = registered
    // but not servable right now (quota, cooldown, a disabled key).
    unavailable: known.available === false || !available.some(model => model.id === id),
  };
}
