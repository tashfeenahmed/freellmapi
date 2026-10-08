// Monthly free-tier budgets are stored as human labels like '~120M', '~50-100M',
// '~12M', or '~500K'. Parse the upper bound to an absolute token count for
// quota math (headroom guardrail, token-usage bar). Returns 0 for unknown/empty
// labels, which callers treat as "no budget info".
//
// Two label shapes the live catalog carries (checked against the signed
// catalog at api.freellmapi.co/v1/latest, 2026-10-04) need more than the bare
// number+unit match:
//
//   - request counts that ride on a K/M unit: 'free · 14.4K rpd',
//     '1K calls/mo shared'. These count requests, not tokens. The old parse
//     read 'free · 14.4K rpd' as a 14,400-TOKEN monthly budget, so
//     headroomFactor reported the model spent after a handful of requests and
//     pinned it to the score floor for the rest of the month — the same class
//     of bug the "40 RPM" guard below already kills, just with the unit letter
//     glued to the number instead of inside an acronym.
//   - daily token caps: 'free · 500K tokens/day', 'free · 1M tokens/24h',
//     'free · 7M/day shared', 'free · 20k tok/day'. The column is a MONTHLY
//     budget, so a daily cap scales by the days it renews in a month. Read as
//     monthly, a 500K/day pool looked exhausted on day one and sat at the
//     headroom floor for the other 29 days although it refilled every night.
export function parseBudget(s: string): number {
  if (!s) return 0;
  const label = String(s).toLowerCase();
  // Drop parenthetical rate hints first ('~2M (60-100/hr)', '~3M (1k
  // credits)'): they describe a side limit, never the budget the head number
  // states, and their unit letters are what a naive scan misreads.
  const head = label.replace(/\([^)]*\)/g, '').trim();
  // Require a magnitude unit (M/K, either case). A bare number with no unit is
  // a rate limit or placeholder, not a monthly token budget — "free · 40 RPM",
  // "free · 200/hr per IP", "promo (trial)", "~? (anon)" — so treat those as
  // "no budget info" (0), per this function's contract. Without the required
  // unit the old regex parsed "free · 40 RPM" as 40 tokens, which showed a
  // bogus budget and made the headroom guardrail penalize the model after one
  // request. The unit must end the token ('5min', '1mo' are not 5M/1M): the
  // lowercased scan would otherwise read a time unit as a magnitude.
  const m = head.match(/~?([\d.]+)(?:-([\d.]+))?([mk])(?![a-z])/);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  // The magnitude must measure tokens. When the unit is immediately followed
  // by a request-shaped word, the number counts requests/calls/messages, not
  // tokens, and has no place in a token budget.
  const tail = head.slice((m.index ?? 0) + m[0].length);
  if (/^\s*(?:rpd|rpm|rph|rps|req|requests?|calls?|messages?|prompts?|neurons?)\b/.test(tail)) return 0;
  const tokens = high * (m[3] === 'm' ? 1_000_000 : 1_000);
  // A per-day cap is a daily allowance; the column asks for the monthly one,
  // and the pool renews every day (×30). Only a day/24h period qualifies, and
  // only when it qualifies THIS number ('~120M/mo, 1M/day max' is monthly).
  const period = tail.split(/[,·;]/)[0];
  const perDay = /\b(?:per\s*)?days?\b|\bdaily\b|\b24\s*h(?:rs?|ours?)?\b/.test(period);
  return perDay ? tokens * 30 : tokens;
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
