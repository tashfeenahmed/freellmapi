// Editing helpers for the model-detail alias merges (issue #790).
//
// The unify overrides store merges as `{ into, keys[] }` entries over the WHOLE
// catalog, while the model detail page only ever shows the entries pointing at
// the group it is rendering. Every edit therefore has to be expressed against
// the full list, not the visible slice — doing it by visible-row index deletes
// whatever unrelated entry happens to sit at that position. Pure functions so
// that mapping is unit-testable away from the page.

export interface AliasMerge {
  into: string
  keys: string[]
}

/** Same normalization the server applies to a merge target: case- and
 *  separator-insensitive, so "Llama 3.3 70B" and "llama-3.3-70b" are one group. */
export function normalizeInto(name: string): string {
  return name.trim().toLowerCase().replace(/[\s\-_]+/g, ' ')
}

/** Every alias currently merged into `label`, flattened across entries. */
export function aliasesFor(merges: AliasMerge[], label: string): string[] {
  const target = normalizeInto(label)
  return merges.filter(m => normalizeInto(m.into) === target).flatMap(m => m.keys)
}

/**
 * Add one alias to `label`'s merge entry, keeping the aliases already there.
 * The group's entries are collapsed into one; other groups are untouched. A
 * blank or duplicate alias is a no-op.
 */
export function addAlias(merges: AliasMerge[], label: string, alias: string): AliasMerge[] {
  const key = alias.trim()
  if (!key) return merges
  const target = normalizeInto(label)
  const mine = merges.filter(m => normalizeInto(m.into) === target)
  const others = merges.filter(m => normalizeInto(m.into) !== target)
  const keys = [...new Set([...mine.flatMap(m => m.keys), key])]
  return [...others, { into: label, keys }]
}

/**
 * Drop one alias from `label`'s merge entry, by value rather than by position.
 * An entry left with no keys is removed entirely (the schema requires at least
 * one), and other groups keep every alias they had.
 */
export function removeAlias(merges: AliasMerge[], label: string, alias: string): AliasMerge[] {
  const target = normalizeInto(label)
  return merges
    .map(m => (normalizeInto(m.into) === target ? { ...m, keys: m.keys.filter(k => k !== alias) } : m))
    .filter(m => m.keys.length > 0)
}
