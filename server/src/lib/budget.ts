// Monthly free-tier budgets are stored as human labels like '~120M', '~50-100M',
// '~12M', or '~500K'. Parse the upper bound to an absolute token count for
// quota math (headroom guardrail, token-usage bar). Returns 0 for unknown/empty
// labels, which callers treat as "no budget info".
export function parseBudget(s: string): number {
  if (!s) return 0;
  // Require a magnitude unit (M/K). A bare number with no unit is a rate limit
  // or placeholder, not a monthly token budget — "free · 40 RPM",
  // "free · 200/hr per IP", "promo (trial)", "~? (anon)" — so treat those as
  // "no budget info" (0), per this function's contract. Without the required
  // unit the old regex parsed "free · 40 RPM" as 40 tokens, which showed a bogus
  // budget and made the headroom guardrail penalize the model after one request.
  const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])/);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  const unit = m[3] === 'M' ? 1_000_000 : 1_000;
  return high * unit;
}

// Sort score for the "budget" preset on the fallback/profiles dashboards.
// Shares parseBudget so rate-limit labels can't masquerade as budgets: the
// per-route copies this replaced multiplied the bare number in
// "free · 40 RPM" by 1e6 because the 'M' in "RPM" hit the unit check, ranking
// a 40-requests-per-minute model as a 40-million-token budget.
// tpd_limit still wins when present (a concrete daily cap beats a "~" label),
// and "unlimited"/"∞" labels keep sorting above every parsed budget.
export function monthlyBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  return parseBudget(str);
}
