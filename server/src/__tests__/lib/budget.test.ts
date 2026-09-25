import { describe, it, expect } from 'vitest';
import { parseBudget, monthlyBudgetScore } from '../../lib/budget.js';

describe('parseBudget', () => {
  it('parses token-count labels to their upper bound', () => {
    expect(parseBudget('~30M')).toBe(30_000_000);
    expect(parseBudget('~120M')).toBe(120_000_000);
    expect(parseBudget('~50-100M')).toBe(100_000_000); // upper bound of a range
    expect(parseBudget('~1-3M')).toBe(3_000_000);
    expect(parseBudget('~500K')).toBe(500_000);
  });

  it('ignores trailing rate hints but keeps the token estimate', () => {
    expect(parseBudget('~2M (60-100/hr)')).toBe(2_000_000);
    expect(parseBudget('~2-3M (200/hr)')).toBe(3_000_000);
  });

  it('returns 0 for rate limits / placeholders with no token magnitude (the NVIDIA case)', () => {
    expect(parseBudget('free · 40 RPM')).toBe(0);
    expect(parseBudget('free · 200/hr per IP')).toBe(0);
    expect(parseBudget('promo (trial)')).toBe(0);
    expect(parseBudget('~? (anon)')).toBe(0);
  });

  it('returns 0 for empty/missing input', () => {
    expect(parseBudget('')).toBe(0);
    expect(parseBudget(undefined as unknown as string)).toBe(0);
  });
});

describe('monthlyBudgetScore', () => {
  const score = (b: string, tpd: number | null = null) =>
    monthlyBudgetScore({ monthly_token_budget: b, tpd_limit: tpd });

  it('scores token labels by their parsed upper bound', () => {
    expect(score('~25M')).toBe(25_000_000);
    expect(score('~1-3M')).toBe(3_000_000);
    expect(score('~500K')).toBe(500_000);
    expect(score('~3M (1k credits)')).toBe(3_000_000);
  });

  it('scores rate-limit labels as 0 instead of inflating them (the "40 RPM" bug)', () => {
    // The old per-route copy matched the bare 40 and applied the 'M' unit
    // from "RPM", scoring 40,000,000 — above every real free-tier budget.
    expect(score('free · 40 RPM')).toBe(0);
    expect(score('free · 200/hr per IP')).toBe(0);
    expect(score('credits-based')).toBe(0);
    expect(score('free · 40 RPM')).toBeLessThan(score('~25M'));
  });

  it('prefers a concrete tpd_limit over any label', () => {
    expect(score('~120M', 1_000_000)).toBe(30_000_000);
    expect(score('', 100_000)).toBe(3_000_000);
  });

  it('keeps unlimited labels above every parsed budget', () => {
    expect(score('unlimited')).toBe(Infinity);
    expect(score('∞')).toBe(Infinity);
  });
});
