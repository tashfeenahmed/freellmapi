import { useMemo, useState } from 'react'

// Draft-then-save form state (M33): local edits over a server value until Save.
// Answers what every such form decided on its own, with three different
// answers: what to show, whether anything changed, and when a save is over.
export interface Draft<T> {
  /** The draft while it differs from the server value, else the server value. */
  value: T
  /** True only while the draft differs (deep compare), so undoing an edit clears it. */
  dirty: boolean
  edit: (next: T) => void
  discard: () => void
  /**
   * Call after a save's refetch has landed, with the value that was saved.
   * Drops the draft only if it is still that value: an edit made while the
   * save was in flight stays.
   */
  settle: (saved: T) => void
}

export function useDraft<T>(server: T, scope: unknown = null): Draft<T> {
  const [staged, setStaged] = useState<{ scope: unknown; value: T } | null>(null)
  // A draft belongs to the scope it was made in. On a scope change it is
  // dropped, not hidden, so switching back never resurrects it (#1047).
  if (staged && !Object.is(staged.scope, scope)) setStaged(null)
  const draft = staged && Object.is(staged.scope, scope) ? staged.value : null
  const dirty = useMemo(() => draft !== null && !deepEqual(draft, server), [draft, server])
  return {
    value: dirty && draft !== null ? draft : server,
    dirty,
    edit: next => setStaged({ scope, value: next }),
    discard: () => setStaged(null),
    settle: saved => setStaged(s => (s && s.value === saved ? null : s)),
  }
}

/** Structural equality for JSON-shaped data; key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => Object.hasOwn(b, k)
    && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
