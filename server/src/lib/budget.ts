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
