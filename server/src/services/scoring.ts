// ── Bandit routing score ────────────────────────────────────────────────────
//
// A redesign of the analytics-driven router. Instead of summing a pile of
// hand-tuned, dimensionally-incompatible bonuses (a probability + a raw latency
// term + an intelligence term, each hand-capped to keep orderings sane), every
// signal here is normalized to [0, 1] and combined as a CONVEX COMBINATION:
//
//   base = w_rel·reliability + w_speed·speed + w_intel·intelligence
//          (weights are a preset that sums to 1, so base ∈ [0, 1])
//
// Two always-on GUARDRAILS then multiply the base — they never reorder good
// models against each other, they only pull a model down as it gets dangerous:
//
//   effective = base × headroomFactor × rateLimitFactor
//
//   headroomFactor  → protects a model that is nearly out of its free quota
//   rateLimitFactor → demotes a model that is currently throwing 429s
//
// Reliability is drawn from a Beta posterior (Thompson sampling) so exploration
// is automatic and proportional to uncertainty — a model is never permanently
// frozen out after a couple of failures. Speed and intelligence are
// deterministic. The result stays in a bounded, interpretable range and no term
// needs a manual cap to "still beat a 0%-success model".

export interface RoutingWeights {
  reliability: number;
  speed: number;
  intelligence: number;
}

// Strategy is either the legacy manual chain ('priority'), one of the bandit
// presets, or 'custom' (a user-tuned weight vector persisted in settings — see
// router.ts). Each is just a weight vector — the engine is identical.
export type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom';

// How the router picks BETWEEN several keys of one platform, once a model has
// been chosen. Deliberately not a RoutingStrategy: model ranking and key
// selection are independent choices, and folding this into the strategy enum
// would mean switching key policy also switches (or disables) the model bandit.
// 'auto' is the historical behaviour — per-key bandit score, else round-robin.
// 'least-remaining' additionally ranks by observed remaining quota (#919).
export type KeySelectionStrategy = 'auto' | 'least-remaining';

export const BANDIT_PRESETS: Record<Exclude<RoutingStrategy, 'priority' | 'custom'>, RoutingWeights> = {
  // Reliability leads; speed and intelligence split the rest evenly.
  balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
  // Intelligence leads, but reliability still carries real weight so a smart
  // model that keeps failing doesn't win.
  smartest: { reliability: 0.35, speed: 0.1, intelligence: 0.55 },
  // Speed leads; reliability keeps a fast-but-broken model from winning.
  fastest: { reliability: 0.35, speed: 0.55, intelligence: 0.1 },
  // Reliability dominates — for clients that just want it to work.
  reliable: { reliability: 0.7, speed: 0.15, intelligence: 0.15 },
};

// Analytics-driven routing is on by default ('balanced'). Operators who want the
// old hand-ordered chain can switch the strategy to 'priority' from the
// dashboard or PUT /api/fallback/routing.
export const DEFAULT_STRATEGY: RoutingStrategy = 'balanced';

// ── Time-of-day dynamic ranking (#760) ─────────────────────────────────────
// During an operator-declared peak window free relays are congested, so a
// model's raw throughput is a weaker signal than its reliability: part of the
// speed weight is moved onto reliability. This is OFF by default and every
// parameter is operator-set — routing that silently changes with the wall
// clock is impossible to reason about when someone reports "it picked a
// different model this evening".
//
// The hour is read in an explicit IANA timezone, never the server's local
// clock: the box a gateway runs on is frequently UTC (containers, VPS images)
// while the traffic it serves is not, so `getHours()` would define "peak" as
// whatever the host image happened to be built with.

/** Persisted peak-hours settings. `enabled` false ⇒ presets are untouched. */
export interface PeakHoursConfig {
  enabled: boolean;
  /** Window start hour, inclusive, 0–23. */
  startHour: number;
  /** Window end hour, exclusive, 0–23. May be < startHour (window spans midnight). */
  endHour: number;
  /** IANA timezone name the hours are interpreted in. */
  timezone: string;
}

export const DEFAULT_PEAK_START_HOUR = 18;
export const DEFAULT_PEAK_END_HOUR = 6; // default window spans midnight: [18, 24) ∪ [0, 6)
export const DEFAULT_PEAK_TIMEZONE = 'UTC';

/** Fraction of the speed weight moved onto reliability during peak hours. */
export const PEAK_SPEED_TO_RELIABILITY = 0.6;

export const DEFAULT_PEAK_HOURS: PeakHoursConfig = {
  enabled: false,
  startHour: DEFAULT_PEAK_START_HOUR,
  endHour: DEFAULT_PEAK_END_HOUR,
  timezone: DEFAULT_PEAK_TIMEZONE,
};

/**
 * Presets exempt from the peak adjustment.
 *
 * `fastest` and `reliable` are the two ends of the speed↔reliability axis, and
 * they are what an operator picks when they have already decided which end they
 * want. Shifting 60% of `fastest`'s 0.55 speed weight would leave it at
 * reliability 0.68 / speed 0.22 — i.e. `fastest` would quietly become a slightly
 * noisy copy of `reliable`, which is a different preset the user could have
 * selected. `reliable` is exempt for the mirror-image reason: it is already the
 * reliability extreme, so there is nothing the adjustment can add, and moving
 * its speed weight only pushes it past the range any preset offers. The
 * adjustment therefore applies only to the mixed presets (`balanced`,
 * `smartest`), where trading some speed weight for reliability stays inside the
 * span the presets already describe. Clamping instead of exempting was the
 * alternative; exempting is chosen because it keeps each preset's identity
 * exactly, rather than making two of them silently converge on a third.
 */
export const PEAK_EXEMPT_STRATEGIES: readonly RoutingStrategy[] = ['fastest', 'reliable'];

/** Whether this strategy opts out of the peak adjustment (see above). */
export function isPeakExemptStrategy(strategy: RoutingStrategy): boolean {
  return PEAK_EXEMPT_STRATEGIES.includes(strategy);
}

/** True when `hour` is a whole number in 0–23. */
export function isValidPeakHour(hour: unknown): hour is number {
  return typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

/** True when `timezone` is an IANA name this runtime's ICU data knows. */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The hour (0–23) at `now` in `timezone`. Uses Intl rather than Date#getHours
 * so the window means the same thing regardless of the host's TZ. An unknown
 * timezone falls back to UTC instead of throwing — routing must never fail
 * because a settings row went stale.
 */
export function hourInTimezone(now: Date, timezone: string): number {
  const zone = isValidTimezone(timezone) ? timezone : DEFAULT_PEAK_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now);
  const raw = parts.find(p => p.type === 'hour')?.value ?? '0';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed % 24 : 0;
}

/**
 * True when `now` falls inside the configured window. `startHour === endHour`
 * is an EMPTY window, not a 24-hour one: an operator who drags both ends to the
 * same value means "nothing", and the alternative (always peak) would be a
 * permanent silent reweight from a config that looks like a no-op.
 */
export function isPeakHours(config: PeakHoursConfig, now = new Date()): boolean {
  if (!config.enabled) return false;
  if (!isValidPeakHour(config.startHour) || !isValidPeakHour(config.endHour)) return false;
  if (config.startHour === config.endHour) return false;
  const h = hourInTimezone(now, config.timezone);
  return config.startHour < config.endHour
    ? h >= config.startHour && h < config.endHour
    : h >= config.startHour || h < config.endHour;
}

/**
 * Peak-adjusted weights for a bandit preset, plus whether the adjustment
 * actually fired (the dashboard labels the weight summary from that flag).
 * Returns the base vector untouched when the feature is off, when the clock is
 * outside the window, or when the strategy is exempt.
 */
export function peakAdjustedWeights(
  base: RoutingWeights,
  strategy: RoutingStrategy,
  config: PeakHoursConfig,
  now = new Date(),
): { weights: RoutingWeights; adjusted: boolean } {
  if (isPeakExemptStrategy(strategy)) return { weights: base, adjusted: false };
  if (!isPeakHours(config, now)) return { weights: base, adjusted: false };
  const shift = base.speed * PEAK_SPEED_TO_RELIABILITY;
  if (shift <= 0) return { weights: base, adjusted: false };
  return {
    weights: {
      reliability: base.reliability + shift,
      speed: base.speed - shift,
      intelligence: base.intelligence,
    },
    adjusted: true,
  };
}

// ── Reliability ───────────────────────────────────────────────────────────
// Beta(1,1) prior = uniform: an unseen model is genuinely uncertain, not assumed
// good or bad. With decay-weighted pseudo-counts the alpha/beta are continuous.
export const PRIOR_SUCCESS = 1;
export const PRIOR_FAILURE = 1;

/** Community-sourced prior counts, folded into the Beta posterior as the
 *  starting balance (#685 follow-up). `successes`/`failures` are the
 *  decay-weighted LOCAL sample counts; the community numbers are the
 *  aggregated, de-poisoned counts from other instances. Local samples dilute
 *  the community prior automatically: the more this install has observed, the
 *  less the shared starting point matters. */
export interface CommunityReliabilityPrior {
  successes: number;
  failures: number;
}

export function reliabilityPosterior(
  successes: number,
  failures: number,
  community?: CommunityReliabilityPrior,
): { alpha: number; beta: number } {
  return {
    alpha: Math.max(0, successes) + (community?.successes ?? 0) + PRIOR_SUCCESS,
    beta: Math.max(0, failures) + (community?.failures ?? 0) + PRIOR_FAILURE,
  };
}

// Deterministic expected reliability — used for the dashboard display score.
export function expectedReliability(
  successes: number,
  failures: number,
  community?: CommunityReliabilityPrior,
): number {
  const { alpha, beta } = reliabilityPosterior(successes, failures, community);
  return alpha / (alpha + beta);
}

// ── Speed (throughput + TTFB blended into one [0,1] axis) ───────────────────
// Throughput uses a saturating curve so one very fast tiny model can't make a
// perfectly-fine larger model look "slow" (the global-max-normalization bug in
// the fork). TTFB is a simple linear ramp from "instant" to "painfully slow".
export const SPEED_SCALE_TOK_S = 60;   // tok/s at which throughput ≈ 0.63
export const TTFB_BEST_MS = 300;       // ≤ this → full latency credit
export const TTFB_WORST_MS = 5000;     // ≥ this → zero latency credit
const THROUGHPUT_WEIGHT = 0.6;         // within the speed axis
const TTFB_WEIGHT = 0.4;
// Optimistic prior so unmeasured models still get explored on the speed axis.
export const SPEED_PRIOR = 0.6;

function throughputScore(tokPerSec: number): number {
  if (tokPerSec <= 0) return 0;
  return 1 - Math.exp(-tokPerSec / SPEED_SCALE_TOK_S);
}

function ttfbScore(ttfbMs: number): number {
  if (ttfbMs <= TTFB_BEST_MS) return 1;
  if (ttfbMs >= TTFB_WORST_MS) return 0;
  return 1 - (ttfbMs - TTFB_BEST_MS) / (TTFB_WORST_MS - TTFB_BEST_MS);
}

/**
 * Blend throughput and TTFB into a single [0,1] speed score.
 * `tokPerSec <= 0` means no successful samples → return the exploration prior.
 * `ttfbMs === null` means we have throughput but no first-byte timing → fall
 * back to throughput alone rather than guessing latency.
 */
export function speedScore(tokPerSec: number, ttfbMs: number | null): number {
  if (tokPerSec <= 0 && ttfbMs === null) return SPEED_PRIOR;
  const tp = throughputScore(tokPerSec);
  if (ttfbMs === null) return tp;
  if (tokPerSec <= 0) return ttfbScore(ttfbMs);
  return THROUGHPUT_WEIGHT * tp + TTFB_WEIGHT * ttfbScore(ttfbMs);
}

// ── Speed: what a timeout costs (#619) ──────────────────────────────────────
// A request that times out IS the model being slow — the reporter's exact
// complaint: a relay model that hangs on half its calls loses reliability but
// used to keep a pristine speed number, because the analytics query fed the
// speed axis from `status = 'success'` rows ONLY. So a timeout now contributes
// to the speed window as what it actually was: its wall-clock latency with ZERO
// output tokens (dragging throughput down) and that same latency as its
// first-byte time (which lands past TTFB_WORST_MS, i.e. no latency credit).
//
// Capped, because `latency_ms` on a timed-out row is unbounded — a provider
// that holds a socket open for twenty minutes, or a per-platform
// PROVIDER_TIMEOUT override in the hundreds of seconds, would otherwise let a
// single hang dominate the whole 7-day window and flatten the axis for every
// model on that platform. Two minutes is above the built-in per-attempt HTTP
// deadline and the 90s stream-stall watchdog, so a normal timeout is counted in
// full and only genuine outliers are clipped.
export const TIMEOUT_LATENCY_CAP_MS = 120_000;

// ── Observed speed rank ─────────────────────────────────────────────────────
// `models.speed_rank` is the catalog's hand-assigned "how fast is this model"
// ordering (1 = fastest; the shipped catalog spans 1..11) and it drives the
// dashboard's sort-by-speed preset. Until now nothing ever wrote it at runtime,
// so it stayed frozen at whatever the seed said no matter how the model
// actually behaved (#619). observedSpeedRank projects the live [0,1] speed axis
// back onto that same low-is-fast scale so an observed rank is directly
// comparable with a catalog one.
export const OBSERVED_SPEED_RANK_BEST = 1;
export const OBSERVED_SPEED_RANK_WORST = 10;

export function observedSpeedRank(speed: number): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(speed) ? speed : 0));
  const span = OBSERVED_SPEED_RANK_WORST - OBSERVED_SPEED_RANK_BEST;
  return OBSERVED_SPEED_RANK_BEST + Math.round((1 - s) * span);
}

// ── Intelligence ────────────────────────────────────────────────────────────
// `size_label` is the CROSS-PROVIDER capability tier (issue #135 — a seeded
// intelligence_rank is only calibrated within one provider's own catalog), so
// tier still dominates and no rank can promote a model past the tier above it.
// Inside a tier, though, rank is no longer a near-invisible tiebreak: it now
// has a real, visible effect on the composite ACROSS providers by design, so
// that a user's rank edit actually moves the axis and the routing order
// (#673). A label we don't recognize scores below every real tier — it is the
// FLOOR of this axis, not an exclusion from routing: intelligence is one
// weighted term in the convex combination below, so an untiered model with
// strong reliability and speed still wins routes under most presets. Custom
// models are seeded at the catalog median tier for the same reason
// (custom-model-seed.ts, #488) — "unknown" is no opinion, not "worst".
export const TIER_VALUE: Record<string, number> = { Frontier: 4, Large: 3, Medium: 2, Small: 1 };

export function tierValue(sizeLabel: string): number {
  return TIER_VALUE[sizeLabel] ?? 0;
}

// Rank is 1..1000 with 1 = best. A LINEAR rank term made the axis effectively
// blind to user edits (#673): tier*1000 dwarfed the rank, and the chain-level
// min-max normalization diluted a few-rank-point change to well under a
// displayed percentage point, so "set the intelligence rank to a better
// number" looked like it did nothing. Compress the rank with a square root so
// edits near the top of the range (1 vs 3 vs 10) are visible on the axis and
// in routing, while the tier keeps strict dominance: the worst rank in a tier
// (sqrt(1000)*31 ≈ 980 < 1000) still beats the best rank of the tier below.
const RANK_SCALE = 31;

export function intelligenceComposite(sizeLabel: string, intelligenceRank: number): number {
  // tier*1000 keeps tiers strictly separated; -sqrt(rank)*RANK_SCALE prefers
  // lower rank in-tier but lets rank edits move the axis (see #673).
  return tierValue(sizeLabel) * 1000 - Math.sqrt(Math.max(1, intelligenceRank)) * RANK_SCALE;
}

// Caller supplies a composite (tier-first, sqrt-compressed rank — see above) and
// the min/max across the enabled chain. We min-max normalize to [0,1], 1 = best.
export function intelligenceScore(composite: number, min: number, max: number): number {
  if (max <= min) return 1; // single model or all equal → neutral-high
  return (composite - min) / (max - min);
}

// ── Guardrail: free-quota headroom ──────────────────────────────────────────
// Multiplier that stays at 1 while a model has comfortable monthly headroom and
// ramps down to a floor as it approaches its free-tier cap, so we stop steering
// traffic at a model we're about to burn out. Unknown budget (0) → no opinion.
// Thresholds are tunable per-instance (#899): callers may pass explicit
// rampStart/floor, and the defaults below are the historical behavior (start
// protecting at 20% remaining, floor at 10% of the score). Router wires these
// to persisted settings so operators can tune without a code change.
export const HEADROOM_FLOOR = 0.1;
export const HEADROOM_RAMP_START = 0.2; // start protecting at 20% remaining

export interface HeadroomThresholds {
  /** Remaining-budget fraction at which demotion begins (0..1). */
  rampStart?: number;
  /** Score floor while a model is at 0 remaining budget (0..1). */
  floor?: number;
}

export function headroomFactor(usedTokens: number, budgetTokens: number, opts?: HeadroomThresholds): number {
  if (!budgetTokens || budgetTokens <= 0) return 1; // unknown budget → no opinion
  return headroomRamp(1 - usedTokens / budgetTokens, opts);
}

/** The shared ramp both headroom guardrails ride: 1 while `remaining` (a 0..1
 *  fraction of the quota still available) is comfortable, then linear down to
 *  `floor` as it reaches zero. Factored out so the monthly-budget guardrail and
 *  the rate-window one below cannot drift apart — and so a single pair of
 *  operator-tuned thresholds governs both (#899). */
function headroomRamp(remainingRaw: number, opts?: HeadroomThresholds): number {
  const rampStart = clampUnit(opts?.rampStart, HEADROOM_RAMP_START);
  const floor = clampUnit(opts?.floor, HEADROOM_FLOOR);
  const remaining = Math.max(0, Math.min(1, remainingRaw));
  if (remaining >= rampStart) return 1;
  // Linear from (0 remaining → floor) to (rampStart remaining → 1).
  return floor + (1 - floor) * (remaining / rampStart);
}

// ── Guardrail: rate-window headroom (#899) ──────────────────────────────────
// The monthly-budget guardrail above only has an opinion about models that
// declare a `monthly_token_budget`. The far more common free-tier shape is a
// per-day request or token cap (rpd/tpd, plus the per-minute rpm/tpm), and
// those were purely BINARY: canMakeRequest/canUseTokens reject at 100% and the
// router happily keeps a model pinned at #1 until the very request that
// exhausts it, then eats a 429 and falls through. That is exactly the
// "deprioritize at 82% utilization, prefer the idle peer" behavior the issue
// asks for.
//
// So: same ramp, same tunable thresholds, driven by live window utilization
// instead of monthly tokens. `usedFraction` is the share of the binding window
// limit already consumed (0 = idle, 1 = exhausted); null means the model
// declares no window limits, or has no routable key to measure — in both cases
// the guardrail has no opinion and returns 1.
//
// Recovery is automatic and needs no bookkeeping: the windows are sliding, so a
// demoted model's utilization falls on its own as the minute or the day rolls
// past, and the factor climbs straight back to 1.
export function rateWindowHeadroomFactor(usedFraction: number | null, opts?: HeadroomThresholds): number {
  if (usedFraction === null || !Number.isFinite(usedFraction)) return 1; // unknown → no opinion
  return headroomRamp(1 - usedFraction, opts);
}

// Out-of-range / non-finite operator input falls back to the default rather
// than silently clamping to a legal-but-unintended value (#899).
function clampUnit(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

// ── Guardrail: live rate-limit penalty ──────────────────────────────────────
// Maps the existing 0..MAX_PENALTY 429 penalty to a multiplier. At max penalty a
// model keeps 40% of its score — demoted hard but never fully excluded, so it
// can recover once the penalty decays.
export const MAX_PENALTY = 10;
export const RATE_LIMIT_MAX_DAMP = 0.6;

export function rateLimitFactor(penalty: number): number {
  const p = Math.min(Math.max(0, penalty), MAX_PENALTY);
  return 1 - (p / MAX_PENALTY) * RATE_LIMIT_MAX_DAMP;
}

// ── Beta sampler (Marsaglia & Tsang via two Gamma draws) ────────────────────
function randomNormal(): number {
  const u1 = Math.random() || Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random() || Number.EPSILON, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = randomNormal(); v = 1 + c * x; } while (v <= 0);
    v = v ** 3;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const sum = x + y;
  return sum > 0 ? x / sum : 0.5;
}

// ── The combined score ──────────────────────────────────────────────────────
export interface ScoreInputs {
  reliability: number;   // [0,1] — sampled (routing) or expected (display)
  speed: number;         // [0,1]
  intelligence: number;  // [0,1]
  headroom: number;      // [floor,1] multiplier
  rateLimit: number;     // [floor,1] multiplier
}

/**
 * Convex base (∈[0,1]) × the two guardrail multipliers. The weights are assumed
 * to sum to 1; if a caller passes a non-normalized vector we renormalize so the
 * base never escapes [0,1].
 */
export function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number {
  const wSum = weights.reliability + weights.speed + weights.intelligence || 1;
  const base =
    (weights.reliability * inputs.reliability +
      weights.speed * inputs.speed +
      weights.intelligence * inputs.intelligence) / wSum;
  return base * inputs.headroom * inputs.rateLimit;
}
