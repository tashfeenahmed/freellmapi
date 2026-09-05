import { describe, it, expect } from 'vitest';
import {
  BANDIT_PRESETS, combineScore, speedScore, intelligenceScore, intelligenceComposite,
  headroomFactor, rateWindowHeadroomFactor, rateLimitFactor, sampleBeta, reliabilityPosterior,
  expectedReliability, SPEED_PRIOR, HEADROOM_FLOOR,
  isPeakHours, peakAdjustedWeights, hourInTimezone, isValidPeakHour, isValidTimezone,
  isPeakExemptStrategy, DEFAULT_PEAK_HOURS, PEAK_SPEED_TO_RELIABILITY,
  taskAdjustedWeights, isTaskExemptStrategy, TASK_WEIGHT_SHARE,
  type PeakHoursConfig,
} from '../../services/scoring.js';

describe('scoring: reliability posterior', () => {
  it('uniform prior makes an unseen model genuinely uncertain (mean 0.5)', () => {
    expect(expectedReliability(0, 0)).toBeCloseTo(0.5, 5);
  });

  it('successes pull the expected rate up, failures down', () => {
    expect(expectedReliability(9, 1)).toBeGreaterThan(0.7);
    expect(expectedReliability(1, 9)).toBeLessThan(0.3);
  });

  it('posterior adds the priors to the observed counts', () => {
    expect(reliabilityPosterior(5, 3)).toEqual({ alpha: 6, beta: 4 });
  });

  it('community prior folds in as the starting balance (#685)', () => {
    // Unseen model + a strong community record → starts near the community rate.
    const withCommunity = expectedReliability(0, 0, { successes: 98, failures: 2 });
    expect(withCommunity).toBeGreaterThan(0.9);
    expect(withCommunity).toBeLessThan(1);
    // The posterior carries both the community counts and the uniform priors.
    expect(reliabilityPosterior(1, 0, { successes: 98, failures: 2 }))
      .toEqual({ alpha: 100, beta: 3 });
  });

  it('local samples dilute the community prior automatically (#685)', () => {
    // A tiny community prior barely moves the posterior once the install has
    // hundreds of its own samples: 1001/1012 ≈ 0.989 vs 0.99 local-only.
    const mostlyLocal = expectedReliability(990, 10, { successes: 10, failures: 0 });
    expect(mostlyLocal).toBeGreaterThan(0.98);
    // No community prior → pure uniform prior on an unseen model.
    expect(expectedReliability(0, 0)).toBeCloseTo(0.5, 5);
  });
});

describe('scoring: speed axis', () => {
  it('returns the exploration prior when there is no data at all', () => {
    expect(speedScore(0, null)).toBe(SPEED_PRIOR);
  });

  it('is bounded in [0,1] and monotonic in throughput', () => {
    const a = speedScore(10, null);
    const b = speedScore(50, null);
    const c = speedScore(200, null);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('a fast TTFB raises the score versus a slow one at equal throughput', () => {
    const fast = speedScore(80, 200);
    const slow = speedScore(80, 6000);
    expect(fast).toBeGreaterThan(slow);
  });

  it('falls back to throughput-only when TTFB is unknown', () => {
    expect(speedScore(80, null)).toBeGreaterThan(0);
  });
});

describe('scoring: intelligence axis', () => {
  it('maps the static 1–200 Intelligence Rank directly to the axis', () => {
    expect(intelligenceScore(1, 1, 200)).toBeCloseTo(0.005, 5);
    expect(intelligenceScore(200, 1, 200)).toBeCloseTo(1, 5);
    expect(intelligenceScore(100, 1, 200)).toBeCloseTo(0.5, 5);
  });

  it('keeps the configured rank even when the chain has one model', () => {
    expect(intelligenceScore(200, 200, 200)).toBe(1);
  });
});

describe('scoring: intelligence_rank is visible on the axis (#673)', () => {
  const axis = (rank: number) => intelligenceScore(intelligenceComposite('Large', rank), 1, 200);
  // The dashboard renders Math.round(value * 100) (client AxisBar).
  const shown = (rank: number) => Math.round(axis(rank) * 100);

  it('a rank 6 → 200 edit moves the displayed axis visibly', () => {
    expect(shown(200) - shown(6)).toBeGreaterThanOrEqual(2);
  });

  it('a higher rank always improves the displayed axis', () => {
    expect(shown(30) - shown(10)).toBeGreaterThanOrEqual(2);
  });

  it('stays monotonic: a higher rank never scores lower', () => {
    for (let rank = 2; rank <= 200; rank++) {
      expect(intelligenceComposite('Large', rank)).toBeGreaterThan(intelligenceComposite('Large', rank - 1));
    }
  });

  it('uses Intelligence Rank as the sole static intelligence baseline across tiers', () => {
    expect(intelligenceComposite('Frontier', 42)).toBe(42);
    expect(intelligenceComposite('Small', 42)).toBe(42);
  });

  it('does not change the static baseline for an unrecognized size label', () => {
    expect(intelligenceComposite('', 120)).toBe(120);
  });
});

describe('scoring: guardrails', () => {
  it('headroom is 1 with plenty left and ramps to the floor when exhausted', () => {
    expect(headroomFactor(0, 1_000_000)).toBe(1);
    expect(headroomFactor(500_000, 1_000_000)).toBe(1);   // 50% left → no opinion
    expect(headroomFactor(1_000_000, 1_000_000)).toBeCloseTo(HEADROOM_FLOOR, 5); // fully used
    expect(headroomFactor(900_000, 1_000_000)).toBeLessThan(1); // 10% left → protecting
  });

  it('honors tunable rampStart/floor thresholds (#899)', () => {
    // Aggressive operator: start protecting at 50% remaining, floor at 0.3.
    const opts = { rampStart: 0.5, floor: 0.3 };
    expect(headroomFactor(400_000, 1_000_000, opts)).toBe(1); // 60% left ≥ rampStart → no opinion
    expect(headroomFactor(500_000, 1_000_000, opts)).toBe(1); // exactly at rampStart → not yet demoting
    // 40% left → demoting: floor + (1-floor)·(remaining/rampStart)
    //            = 0.3 + 0.7·(0.4/0.5) = 0.86
    expect(headroomFactor(600_000, 1_000_000, opts)).toBeCloseTo(0.86, 5);
    expect(headroomFactor(1_000_000, 1_000_000, opts)).toBeCloseTo(0.3, 5); // fully used → floor
  });

  it('clamps out-of-range thresholds to defaults (#899)', () => {
    expect(headroomFactor(500_000, 1_000_000, { rampStart: 2, floor: -1 }))
      .toBe(headroomFactor(500_000, 1_000_000)); // same as default behavior
    expect(headroomFactor(500_000, 1_000_000, { rampStart: NaN }))
      .toBe(headroomFactor(500_000, 1_000_000));
  });

  it('unknown budget yields no opinion (factor 1)', () => {
    expect(headroomFactor(123, 0)).toBe(1);
  });

  it('rate-window headroom rides the same ramp as the monthly one (#899)', () => {
    expect(rateWindowHeadroomFactor(0)).toBe(1);      // idle
    expect(rateWindowHeadroomFactor(0.5)).toBe(1);    // 50% left, ramp starts at 20%
    // Exactly at the ramp start: 1 - 0.8 lands a float ulp under 0.2, so this
    // is the very top of the ramp rather than the flat part. Same arithmetic
    // the monthly guardrail has always done.
    expect(rateWindowHeadroomFactor(0.8)).toBeCloseTo(1, 9);
    // 5% of the window left → 0.1 + 0.9·(0.05/0.2)
    expect(rateWindowHeadroomFactor(0.95)).toBeCloseTo(0.325, 5);
    expect(rateWindowHeadroomFactor(1)).toBeCloseTo(HEADROOM_FLOOR, 5);
    // Over-consumption (a provider counted more than we did) cannot go below
    // the floor.
    expect(rateWindowHeadroomFactor(1.4)).toBeCloseTo(HEADROOM_FLOOR, 5);
    // The two guardrails agree wherever the remaining fraction agrees.
    expect(rateWindowHeadroomFactor(0.95)).toBeCloseTo(headroomFactor(950, 1000), 10);
  });

  it('rate-window headroom takes the same tunable thresholds (#899)', () => {
    const opts = { rampStart: 0.5, floor: 0.3 };
    expect(rateWindowHeadroomFactor(0.4, opts)).toBe(1);            // 60% left
    expect(rateWindowHeadroomFactor(0.6, opts)).toBeCloseTo(0.86, 5); // 0.3 + 0.7·(0.4/0.5)
    expect(rateWindowHeadroomFactor(0.6, { rampStart: 5 }))
      .toBe(rateWindowHeadroomFactor(0.6)); // out of range → defaults
  });

  it('no measurable window yields no opinion (factor 1)', () => {
    expect(rateWindowHeadroomFactor(null)).toBe(1);
    expect(rateWindowHeadroomFactor(NaN)).toBe(1);
  });

  it('rate-limit factor is 1 at no penalty and damped but non-zero at max', () => {
    expect(rateLimitFactor(0)).toBe(1);
    expect(rateLimitFactor(10)).toBeCloseTo(0.4, 5);
    expect(rateLimitFactor(100)).toBeCloseTo(0.4, 5); // clamped
  });
});

describe('scoring: combineScore', () => {
  const perfect = { reliability: 1, speed: 1, intelligence: 1, headroom: 1, rateLimit: 1 };

  it('stays within [0,1] for in-range inputs', () => {
    expect(combineScore(perfect, BANDIT_PRESETS.balanced)).toBeLessThanOrEqual(1);
    expect(combineScore({ reliability: 0, speed: 0, intelligence: 0, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.balanced)).toBe(0);
  });

  it('a 100%-reliable slow model beats a 0%-reliable fast one under balanced — no hand-cap needed', () => {
    const reliable = combineScore({ reliability: 1, speed: 0.1, intelligence: 0.5, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.balanced);
    const flaky = combineScore({ reliability: 0, speed: 1, intelligence: 0.5, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.balanced);
    expect(reliable).toBeGreaterThan(flaky);
  });

  it('the smartest preset ranks a high-intelligence model above a fast one', () => {
    const smart = combineScore({ reliability: 0.8, speed: 0.2, intelligence: 1, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.smartest);
    const fast = combineScore({ reliability: 0.8, speed: 1, intelligence: 0.2, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.smartest);
    expect(smart).toBeGreaterThan(fast);
  });

  it('the fastest preset flips that ordering', () => {
    const smart = combineScore({ reliability: 0.8, speed: 0.2, intelligence: 1, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.fastest);
    const fast = combineScore({ reliability: 0.8, speed: 1, intelligence: 0.2, headroom: 1, rateLimit: 1 }, BANDIT_PRESETS.fastest);
    expect(fast).toBeGreaterThan(smart);
  });

  it('guardrails multiply the base down', () => {
    const base = combineScore(perfect, BANDIT_PRESETS.balanced);
    const throttled = combineScore({ ...perfect, rateLimit: 0.4 }, BANDIT_PRESETS.balanced);
    expect(throttled).toBeCloseTo(base * 0.4, 5);
  });

  it('every preset weight vector sums to 1', () => {
    for (const w of Object.values(BANDIT_PRESETS)) {
      expect(w.reliability + w.speed + w.intelligence).toBeCloseTo(1, 5);
    }
  });
});

describe('scoring: Beta sampler (Thompson exploration)', () => {
  it('draws stay within (0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const x = sampleBeta(3, 5);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('the sample mean approximates alpha/(alpha+beta)', () => {
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += sampleBeta(8, 2);
    expect(sum / n).toBeCloseTo(0.8, 1); // E[Beta(8,2)] = 0.8
  });

  it('explores: a strong model does NOT win every single draw vs a decent one', () => {
    // Beta(20,2) ≈ 0.91 vs Beta(12,4) ≈ 0.75 — overlapping tails mean the
    // weaker model should still sometimes sample higher. That overlap is what
    // keeps the router from freezing onto a single model.
    let weakerWonAtLeastOnce = false;
    for (let i = 0; i < 2000 && !weakerWonAtLeastOnce; i++) {
      if (sampleBeta(12, 4) > sampleBeta(20, 2)) weakerWonAtLeastOnce = true;
    }
    expect(weakerWonAtLeastOnce).toBe(true);
  });
});

describe('scoring: time-of-day dynamic ranking (#760)', () => {
  // Every timestamp below is an absolute instant (Z), so the timezone under
  // test — not the machine running the suite — decides which hour it is.
  const cfg = (patch: Partial<PeakHoursConfig> = {}): PeakHoursConfig =>
    ({ ...DEFAULT_PEAK_HOURS, enabled: true, ...patch });

  it('is off by default', () => {
    expect(DEFAULT_PEAK_HOURS.enabled).toBe(false);
    expect(DEFAULT_PEAK_HOURS.startHour).toBe(18);
    expect(DEFAULT_PEAK_HOURS.endHour).toBe(6);
    expect(DEFAULT_PEAK_HOURS.timezone).toBe('UTC');
    const base = BANDIT_PRESETS.balanced;
    // 20:00 UTC is inside the default window, but the flag is off.
    const out = peakAdjustedWeights(base, 'balanced', DEFAULT_PEAK_HOURS, new Date('2026-08-18T20:00:00Z'));
    expect(out.weights).toEqual(base);
    expect(out.adjusted).toBe(false);
  });

  it('reads the hour in the configured timezone, not the host clock', () => {
    const noonUtc = new Date('2026-08-18T12:00:00Z');
    expect(hourInTimezone(noonUtc, 'UTC')).toBe(12);
    expect(hourInTimezone(noonUtc, 'Asia/Kolkata')).toBe(17);   // +5:30
    expect(hourInTimezone(noonUtc, 'America/Los_Angeles')).toBe(5); // -7 (DST)
    // Midnight must read as 0, never 24 (h23 vs h24 hour cycles).
    expect(hourInTimezone(new Date('2026-08-18T00:00:00Z'), 'UTC')).toBe(0);
    // An unknown zone degrades to UTC rather than throwing mid-route.
    expect(hourInTimezone(noonUtc, 'Mars/Olympus_Mons')).toBe(12);
  });

  it('marks the window per timezone (spans midnight, end exclusive)', () => {
    const utc = cfg();
    expect(isPeakHours(utc, new Date('2026-08-18T18:00:00Z'))).toBe(true);
    expect(isPeakHours(utc, new Date('2026-08-18T23:59:00Z'))).toBe(true);
    expect(isPeakHours(utc, new Date('2026-08-18T00:00:00Z'))).toBe(true);
    expect(isPeakHours(utc, new Date('2026-08-18T05:59:00Z'))).toBe(true);
    expect(isPeakHours(utc, new Date('2026-08-18T06:00:00Z'))).toBe(false);
    expect(isPeakHours(utc, new Date('2026-08-18T12:00:00Z'))).toBe(false);

    // Same instant, two zones: 13:00 UTC is 18:30 in Kolkata (peak) and 13:00
    // in London-summer... which is off-peak. The timezone is what decides.
    const instant = new Date('2026-08-18T13:00:00Z');
    expect(isPeakHours(cfg({ timezone: 'Asia/Kolkata' }), instant)).toBe(true);
    expect(isPeakHours(cfg({ timezone: 'UTC' }), instant)).toBe(false);
  });

  it('supports a same-day window and treats start === end as empty', () => {
    const lunch = cfg({ startHour: 9, endHour: 17 });
    expect(isPeakHours(lunch, new Date('2026-08-18T09:00:00Z'))).toBe(true);
    expect(isPeakHours(lunch, new Date('2026-08-18T16:59:00Z'))).toBe(true);
    expect(isPeakHours(lunch, new Date('2026-08-18T17:00:00Z'))).toBe(false);
    expect(isPeakHours(lunch, new Date('2026-08-18T03:00:00Z'))).toBe(false);

    const empty = cfg({ startHour: 10, endHour: 10 });
    for (const h of [0, 9, 10, 11, 23]) {
      expect(isPeakHours(empty, new Date(`2026-08-18T${String(h).padStart(2, '0')}:30:00Z`))).toBe(false);
    }
  });

  it('shifts speed→reliability inside the window, intelligence untouched', () => {
    const base = BANDIT_PRESETS.balanced; // { reliability: 0.5, speed: 0.25, intelligence: 0.25 }
    const { weights, adjusted } = peakAdjustedWeights(base, 'balanced', cfg(), new Date('2026-08-18T20:00:00Z'));
    const shift = base.speed * PEAK_SPEED_TO_RELIABILITY;
    expect(adjusted).toBe(true);
    expect(weights.reliability).toBeCloseTo(base.reliability + shift, 5);
    expect(weights.speed).toBeCloseTo(base.speed - shift, 5);
    expect(weights.intelligence).toBe(base.intelligence);
    expect(weights.reliability + weights.speed + weights.intelligence).toBeCloseTo(1, 5);
  });

  it('leaves weights alone outside the window', () => {
    const base = BANDIT_PRESETS.smartest;
    const out = peakAdjustedWeights(base, 'smartest', cfg(), new Date('2026-08-18T12:00:00Z'));
    expect(out.weights).toEqual(base);
    expect(out.adjusted).toBe(false);
  });

  it('exempts fastest and reliable so no preset turns into another', () => {
    const inWindow = new Date('2026-08-18T20:00:00Z');
    for (const strategy of ['fastest', 'reliable'] as const) {
      expect(isPeakExemptStrategy(strategy)).toBe(true);
      const out = peakAdjustedWeights(BANDIT_PRESETS[strategy], strategy, cfg(), inWindow);
      expect(out.weights).toEqual(BANDIT_PRESETS[strategy]);
      expect(out.adjusted).toBe(false);
    }
    for (const strategy of ['balanced', 'smartest'] as const) {
      expect(isPeakExemptStrategy(strategy)).toBe(false);
      expect(peakAdjustedWeights(BANDIT_PRESETS[strategy], strategy, cfg(), inWindow).adjusted).toBe(true);
    }
  });

  it('never pushes an adjusted preset past the reliable preset', () => {
    const inWindow = new Date('2026-08-18T20:00:00Z');
    for (const strategy of ['balanced', 'smartest'] as const) {
      const { weights } = peakAdjustedWeights(BANDIT_PRESETS[strategy], strategy, cfg(), inWindow);
      expect(weights.speed).toBeGreaterThanOrEqual(0);
      // The whole point of exempting the extremes: an adjusted mixed preset
      // must not end up more reliability-heavy than `reliable` itself.
      expect(weights.reliability).toBeLessThanOrEqual(BANDIT_PRESETS.reliable.reliability);
      expect(weights.reliability + weights.speed + weights.intelligence).toBeCloseTo(1, 5);
    }
  });

  it('rejects out-of-range hours and unknown timezones', () => {
    for (const h of [0, 6, 18, 23]) expect(isValidPeakHour(h)).toBe(true);
    for (const h of [-1, 24, 6.5, NaN, '6', null, undefined]) expect(isValidPeakHour(h)).toBe(false);
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York']) expect(isValidTimezone(tz)).toBe(true);
    for (const tz of ['', '  ', 'Not/AZone', 'GMT+5', 42, null]) expect(isValidTimezone(tz)).toBe(false);
  });

  it('ignores a stored config with a corrupt window', () => {
    const base = BANDIT_PRESETS.balanced;
    const bad = { enabled: true, startHour: 99, endHour: 6, timezone: 'UTC' } as PeakHoursConfig;
    expect(peakAdjustedWeights(base, 'balanced', bad, new Date('2026-08-18T20:00:00Z')).weights).toEqual(base);
  });
});

describe('scoring: task-type weight bias (#1127)', () => {
  it('moves speed onto intelligence for a code turn, and back for a chat turn', () => {
    const base = BANDIT_PRESETS.balanced;
    const code = taskAdjustedWeights(base, 'code', 'balanced');
    expect(code.adjusted).toBe(true);
    expect(code.weights.intelligence).toBeCloseTo(base.intelligence + base.speed * TASK_WEIGHT_SHARE, 5);
    expect(code.weights.speed).toBeCloseTo(base.speed - base.speed * TASK_WEIGHT_SHARE, 5);
    expect(code.weights.reliability).toBe(base.reliability);
    expect(code.weights.reliability + code.weights.speed + code.weights.intelligence).toBeCloseTo(1, 5);

    const chat = taskAdjustedWeights(base, 'chat', 'balanced');
    expect(chat.adjusted).toBe(true);
    expect(chat.weights.speed).toBeCloseTo(base.speed + base.intelligence * TASK_WEIGHT_SHARE, 5);
    expect(chat.weights.intelligence).toBeCloseTo(base.intelligence - base.intelligence * TASK_WEIGHT_SHARE, 5);
    expect(chat.weights.reliability + chat.weights.speed + chat.weights.intelligence).toBeCloseTo(1, 5);
  });

  it('exempts fastest, reliable and custom', () => {
    // fastest/reliable are the ends of the axis the operator already picked;
    // custom is the vector they set by hand. A per-request header must not
    // rewrite any of the three.
    for (const strategy of ['fastest', 'reliable', 'custom'] as const) {
      expect(isTaskExemptStrategy(strategy)).toBe(true);
      const base = strategy === 'custom'
        ? { reliability: 0.2, speed: 0.5, intelligence: 0.3 }
        : BANDIT_PRESETS[strategy];
      for (const task of ['code', 'chat'] as const) {
        const out = taskAdjustedWeights(base, task, strategy);
        expect(out.weights).toEqual(base);
        expect(out.adjusted).toBe(false);
      }
    }
    for (const strategy of ['balanced', 'smartest'] as const) {
      expect(isTaskExemptStrategy(strategy)).toBe(false);
      expect(taskAdjustedWeights(BANDIT_PRESETS[strategy], 'code', strategy).adjusted).toBe(true);
    }
  });

  it('is a no-op when the axis it would move is already zero', () => {
    const noSpeed = { reliability: 0.5, speed: 0, intelligence: 0.5 };
    expect(taskAdjustedWeights(noSpeed, 'code', 'balanced')).toEqual({ weights: noSpeed, adjusted: false });
    const noIntel = { reliability: 0.5, speed: 0.5, intelligence: 0 };
    expect(taskAdjustedWeights(noIntel, 'chat', 'balanced')).toEqual({ weights: noIntel, adjusted: false });
  });
});
