// Resolving a model id against the catalog, for the launchers.
//
// The subtlety this module exists for: `catalog()` fetches `/v1/models` with
// `?available=true`, so a model missing from that response has TWO possible
// meanings — it does not exist, or it exists and is merely out of quota right
// now. Treating absence as "unknown model" reports a healthy pinned model as a
// typo the moment its provider hits a rate limit. Only the UNFILTERED roster
// can tell those apart, so `--model` is validated against that.

import type { CatalogModel, ContextWindowChoice } from './types.js';

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
 * The window to size a client to (#2122, #2087). By default the advertised
 * context_window: for `auto` that is the window most of the pool holds
 * (#1717), so a session stays where many models can serve it. `max` asks for
 * the largest window the gateway can still serve this model at — for `auto`
 * its max_context_window, the biggest tool-capable model with a key — and a
 * number is taken as given.
 */
export function chosenContextWindow(model: CatalogModel, choice?: ContextWindowChoice): number | undefined {
  if (typeof choice === 'number') return choice;
  if (choice === 'max') return model.max_context_window ?? contextWindowOf(model);
  return contextWindowOf(model);
}

/** Parse `--context-window`: `max`, a token count, or a count with a k/m
 *  suffix (`200k`, `1m`). */
export function parseContextWindow(value: string): ContextWindowChoice {
  const text = value.trim().toLowerCase();
  if (text === 'max') return 'max';
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text);
  const tokens = match ? Math.round(Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1)) : NaN;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new Error(`--context-window must be 'max' or a token count such as 200000 or 200k, got '${value}'`);
  }
  return tokens;
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
  window?: ContextWindowChoice,
): ResolvedModel {
  const id = requested ?? defaultModelId(available);
  const known = full.find(model => model.id === id) ?? available.find(model => model.id === id);

  if (!known) {
    // `auto` is served by the router itself and need not appear in any roster.
    if (id === 'auto') return { id, contextWindow: typeof window === 'number' ? window : undefined, unavailable: false };
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
    contextWindow: chosenContextWindow(known, window),
    // Absent from the filtered roster but present in the full one = registered
    // but not servable right now (quota, cooldown, a disabled key).
    unavailable: known.available === false || !available.some(model => model.id === id),
  };
}
