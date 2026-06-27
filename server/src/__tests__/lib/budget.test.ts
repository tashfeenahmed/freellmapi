import { describe, it, expect } from 'vitest';
import { parseBudget } from '../../lib/budget.js';

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
