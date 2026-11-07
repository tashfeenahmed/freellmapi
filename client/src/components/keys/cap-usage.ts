/** Fraction (0..1+, uncapped = null) of a monthly cap already spent, and
 *  whether it is at/over the 80% soft-alert threshold the server logs at
 *  (services/budget-alerts.ts). Pure so the arithmetic is testable. */
export function capUsage(used: number, cap: number): { fraction: number; overWarning: boolean } | null {
  if (!Number.isFinite(cap) || cap <= 0) return null
  const fraction = Math.max(0, used) / cap
  return { fraction, overWarning: fraction >= 0.8 }
}
