import type { ApiKey } from '../../../shared/types'

/** What the keys-page search box matches per row (#1056 applied to /keys).
 *  The row RENDERS the endpoint URL for custom rows, so the query must reach
 *  it: until now a relay at api.unorouter.com was invisible to a host search
 *  even though the fallback table had carried its endpoint in the hay since
 *  #1056 fixed exactly this there. Extracted as a pure function so the
 *  contract is testable without mounting the page. */
export function keyMatchesQuery(k: ApiKey, query: string): boolean {
  const q = query.toLowerCase()
  return (
    (k.label ?? '').toLowerCase().includes(q) ||
    (k.maskedKey ?? '').toLowerCase().includes(q) ||
    (k.baseUrl ?? '').toLowerCase().includes(q)
  )
}
