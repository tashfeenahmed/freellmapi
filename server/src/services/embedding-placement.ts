import type { Db } from '../db/types.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * embedding-placement — keeps a hand-made family arrangement across catalog syncs.
 *
 * A provider row can be moved into a different embedding family by hand (the
 * dashboard drops it on another family card). catalog-sync rewrites `family` and
 * `priority` from its own snapshot — at boot and twice a day — so without a pin the
 * move would silently revert on the next re-apply and the dashboard would show a
 * different chain than the operator arranged.
 *
 * The pin is the operator's intent, recorded per row: `family` and/or `priority`.
 * Only the keys a caller actually set are stored, and `applyPlacementPins` uses
 * COALESCE so a pin that names only a family does not also freeze the priority.
 */

const PINS_KEY = 'embedding_placement_pins';

export interface PlacementPin {
  /** Target family for the row; omitted means "the pin does not touch the family". */
  family?: string | null;
  /** Target priority inside that family; omitted means "leave the priority alone". */
  priority?: number | null;
}

export type PlacementPins = Record<string, PlacementPin>;

function parsePins(raw: string | undefined): PlacementPins {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PlacementPins;
  } catch {
    // A corrupt pin blob must never take the catalog sync down: the arrangement
    // falls back to the snapshot, which is the pre-pin behaviour.
    return {};
  }
}

export function readPlacementPins(_db: Db): PlacementPins {
  return parsePins(getSetting(PINS_KEY));
}

export function recordPlacementPin(_db: Db, id: number, pin: PlacementPin): void {
  const pins = parsePins(getSetting(PINS_KEY));
  pins[String(id)] = pin;
  setSetting(PINS_KEY, JSON.stringify(pins));
}

export function clearPlacementPin(_db: Db, id: number): void {
  const pins = parsePins(getSetting(PINS_KEY));
  if (!(String(id) in pins)) return;
  delete pins[String(id)];
  setSetting(PINS_KEY, JSON.stringify(pins));
}

/**
 * Re-apply every pinned placement. Called by catalog-sync inside the same
 * transaction as the snapshot it would otherwise be overwritten by.
 *
 * Returns the number of rows the pins actually changed, so a caller (or a test)
 * can tell "pins existed but agreed with the snapshot" from "pins won".
 */
export function applyPlacementPins(db: Db): number {
  const pins = parsePins(getSetting(PINS_KEY));
  const update = db.prepare(
    `UPDATE embedding_models
        SET family = COALESCE(?, family),
            priority = COALESCE(?, priority)
      WHERE id = ?`,
  );
  let applied = 0;
  for (const [rawId, pin] of Object.entries(pins)) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || !pin || typeof pin !== 'object') continue;
    const family = typeof pin.family === 'string' && pin.family ? pin.family : null;
    const priority = Number.isInteger(pin.priority) ? (pin.priority as number) : null;
    if (family === null && priority === null) continue;
    applied += update.run(family, priority, id).changes;
  }
  return applied;
}
