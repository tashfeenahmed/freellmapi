import { describe, it, expect } from 'vitest';
import {
  BANDIT_PRESETS, combineScore, speedScore, intelligenceScore,
  headroomFactor, rateLimitFactor, sampleBeta, reliabilityPosterior,
  expectedReliability, SPEED_PRIOR, HEADROOM_FLOOR,
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
