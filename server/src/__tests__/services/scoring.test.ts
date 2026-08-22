import { describe, it, expect } from 'vitest';
import {
  BANDIT_PRESETS, combineScore, speedScore, intelligenceScore, intelligenceComposite,
  headroomFactor, rateLimitFactor, sampleBeta, reliabilityPosterior,
  expectedReliability, SPEED_PRIOR, HEADROOM_FLOOR,
  isPeakHours, timeOfDayWeights, PEAK_START_HOUR, PEAK_END_HOUR, PEAK_SPEED_TO_RELIABILITY,
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
  it('maps min→0, max→1', () => {
    expect(intelligenceScore(1000, 1000, 4000)).toBeCloseTo(0, 5);
    expect(intelligenceScore(4000, 1000, 4000)).toBeCloseTo(1, 5);
    expect(intelligenceScore(2500, 1000, 4000)).toBeCloseTo(0.5, 5);
  });

  it('returns neutral-high when all models are equal', () => {
    expect(intelligenceScore(5, 5, 5)).toBe(1);
  });
});

describe('scoring: intelligence_rank is visible on the axis (#673)', () => {
  // A realistic three-tier chain. The Frontier model pins the top of the
  // min-max normalization and the Medium model pins the bottom; the Large
  // model in between is the one the user re-ranks, so the span is unchanged by
  // the edit and the whole move comes from the rank term.
  const top = intelligenceComposite('Frontier', 1);
  const bottom = intelligenceComposite('Medium', 50);
  const axis = (rank: number) => intelligenceScore(intelligenceComposite('Large', rank), bottom, top);
  // The dashboard renders Math.round(value * 100) (client AxisBar).
  const shown = (rank: number) => Math.round(axis(rank) * 100);

  it('a rank 6 → 1 edit moves the displayed axis by at least 2 points', () => {
    // Under the old linear `tier*1000 - rank` term this move was ~0.25 points,
    // i.e. the same rendered integer — the edit looked like it did nothing.
    expect(shown(1) - shown(6)).toBeGreaterThanOrEqual(2);
  });

  it('even a small rank improvement is worth more than a rounding artifact', () => {
    // 10 → 3 is a typical "promote this model" edit.
    expect(shown(3) - shown(10)).toBeGreaterThanOrEqual(2);
  });

  it('stays monotonic: a better rank never scores lower', () => {
    for (let rank = 2; rank <= 200; rank++) {
      expect(intelligenceComposite('Large', rank)).toBeLessThan(intelligenceComposite('Large', rank - 1));
    }
  });

  it('keeps tier dominance: the worst rank in a tier still beats the best rank below it', () => {
    for (const [better, worse] of [['Frontier', 'Large'], ['Large', 'Medium'], ['Medium', 'Small']] as const) {
      expect(intelligenceComposite(better, 1000)).toBeGreaterThan(intelligenceComposite(worse, 1));
    }
  });

  it('an unrecognized size label still scores below every real tier', () => {
    expect(intelligenceComposite('', 1)).toBeLessThan(intelligenceComposite('Small', 1000));
  });
});

describe('scoring: guardrails', () => {
  it('headroom is 1 with plenty left and ramps to the floor when exhausted', () => {
    expect(headroomFactor(0, 1_000_000)).toBe(1);
    expect(headroomFactor(500_000, 1_000_000)).toBe(1);   // 50% left → no opinion
    expect(headroomFactor(1_000_000, 1_000_000)).toBeCloseTo(HEADROOM_FLOOR, 5); // fully used
    expect(headroomFactor(900_000, 1_000_000)).toBeLessThan(1); // 10% left → protecting
  });

  it('unknown budget yields no opinion (factor 1)', () => {
    expect(headroomFactor(123, 0)).toBe(1);
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
  function at(hour: number, minute = 0): Date {
    return new Date(2026, 7, 18, hour, minute); // local time, Aug 18
  }

  it('marks peak hours 18:00–06:00 (inclusive start, exclusive end)', () => {
    expect(isPeakHours(at(PEAK_START_HOUR))).toBe(true);      // 18:00 → peak
    expect(isPeakHours(at(23, 59))).toBe(true);               // late night → peak
    expect(isPeakHours(at(0))).toBe(true);                    // midnight → peak
    expect(isPeakHours(at(5, 59))).toBe(true);                // just before 06:00 → peak
    expect(isPeakHours(at(PEAK_END_HOUR))).toBe(false);       // 06:00 → off-peak
    expect(isPeakHours(at(12))).toBe(false);                  // noon → off-peak
  });

  it('keeps off-peak weights unchanged', () => {
    const base = BANDIT_PRESETS.balanced;
    expect(timeOfDayWeights(base, at(12))).toEqual(base);
    expect(timeOfDayWeights(base, at(PEAK_END_HOUR))).toEqual(base);
  });

  it('shifts speed→reliability during peak hours, intelligence untouched', () => {
    const base = BANDIT_PRESETS.balanced; // { reliability: 0.5, speed: 0.25, intelligence: 0.25 }
    const peak = timeOfDayWeights(base, at(20));
    const shift = base.speed * PEAK_SPEED_TO_RELIABILITY;
    expect(peak.reliability).toBeCloseTo(base.reliability + shift, 5);
    expect(peak.speed).toBeCloseTo(base.speed - shift, 5);
    expect(peak.intelligence).toBe(base.intelligence);
    // Weights still sum to 1.
    expect(peak.reliability + peak.speed + peak.intelligence).toBeCloseTo(1, 5);
  });

  it('never returns a negative speed weight for any preset', () => {
    for (const preset of Object.values(BANDIT_PRESETS)) {
      const peak = timeOfDayWeights(preset, at(21));
      expect(peak.speed).toBeGreaterThanOrEqual(0);
      expect(peak.reliability + peak.speed + peak.intelligence).toBeCloseTo(1, 5);
    }
  });

  it('defaults to the current wall-clock time', () => {
    const now = new Date();
    const base = BANDIT_PRESETS.balanced;
    if (isPeakHours(now)) {
      expect(timeOfDayWeights(base)).not.toEqual(base);
    } else {
      expect(timeOfDayWeights(base)).toEqual(base);
    }
  });
});
