import { useEffect, useMemo, useState } from 'react'

// Client-side column sort for the analytics tables; the header cell that
// drives it lives in components/sortable-header.tsx. Each table owns a
// SortState keyed by its own column union `C`; the helpers are generic over
// the row type, so a table only supplies a `SortValueFn` mapping
// (row, column) to the value the column displays.
//
// Cycle per column: null → asc → desc → null. Switching to another column
// starts at asc. `null` renders the rows in API order, which is the right
// default for every table (newest-first / requests DESC).
export type SortDirection = 'asc' | 'desc'
export type SortState<C extends string> = { column: C; direction: SortDirection } | null

// Value a column sorts on. Return null for values the API did not include;
// they sort to the end regardless of direction (spreadsheet convention).
export type SortValueFn<R, C extends string> = (row: R, col: C) => number | string | null

export function compareBy<R, C extends string>(a: R, b: R, col: C, valueOf: SortValueFn<R, C>): number {
  const av = valueOf(a, col)
  const bv = valueOf(b, col)
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  if (typeof av === 'number' && typeof bv === 'number') return av - bv
  return String(av).localeCompare(String(bv))
}

export function loadStoredSort<C extends string>(storageKey: string, validColumns: readonly C[]): SortState<C> {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { column?: unknown; direction?: unknown }
    if (
      typeof parsed.column === 'string'
      && (validColumns as readonly string[]).includes(parsed.column)
      && (parsed.direction === 'asc' || parsed.direction === 'desc')
    ) {
      return { column: parsed.column as C, direction: parsed.direction }
    }
  } catch { /* corrupted entry or storage unavailable — API order */ }
  return null
}

export function persistSort<C extends string>(storageKey: string, sort: SortState<C>): void {
  try {
    if (sort === null) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, JSON.stringify(sort))
  } catch { /* quota / private mode — the sort still applies this session */ }
}

export function nextSort<C extends string>(current: SortState<C>, col: C): SortState<C> {
  if (!current || current.column !== col) return { column: col, direction: 'asc' }
  if (current.direction === 'asc') return { column: col, direction: 'desc' }
  return null
}

// Nulls stay last in BOTH directions: only the non-null comparison is
// flipped for desc, the null placement is not.
export function sortRows<R, C extends string>(rows: R[], sort: SortState<C>, valueOf: SortValueFn<R, C>): R[] {
  if (!sort) return rows
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    const av = valueOf(a, sort.column)
    const bv = valueOf(b, sort.column)
    if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1
    return sign * compareBy(a, b, sort.column, valueOf)
  })
}

// Sort state for one table, remembered in localStorage under `storageKey`
// (same idiom as the page's `analytics.range`). Returns the state and the
// header click handler.
export function useTableSort<C extends string>(storageKey: string, validColumns: readonly C[]) {
  const [sort, setSort] = useState<SortState<C>>(() => loadStoredSort(storageKey, validColumns))
  useEffect(() => persistSort(storageKey, sort), [storageKey, sort])
  const toggle = useMemo(() => (col: C) => setSort((current) => nextSort(current, col)), [])
  return { sort, toggle }
}
