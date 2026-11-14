import { describe, it, expect } from 'vitest';
import type { Round } from '../../services/iterative-critique.js';

const mk = (n: number, total: number, over: Partial<Round> = {}): Round => ({
  round: n, answer: `a${n}`, changes: '', generator: 'g', critic: 'c', parseFailed: false,
  scores: { factuality: total, reasoning: total, completeness: total, helpfulness: total, penalty: 0 },
  flaws: [{ flaw: `f${n}`, severity: 'LOW', evidence: '' }], verdict: 'REVISE', ...over,
});

describe('iterative-critique', () => {
  it('extractJson handles fences, prose and junk', async () => {
    const { extractJson } = await import('../../services/iterative-critique.js');
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure: {"a":2} done')).toEqual({ a: 2 });
    expect(extractJson('nope')).toBeNull();
  });

  it('scoreTotal subtracts the penalty and floors at 0', async () => {
    const { scoreTotal } = await import('../../services/iterative-critique.js');
    expect(scoreTotal(mk(1, 8).scores)).toBe(8);
    expect(scoreTotal({ ...mk(1, 2).scores, penalty: 5 })).toBe(0);
  });

  it('convergence rules fire in order', async () => {
    const { checkConvergence } = await import('../../services/iterative-critique.js');
    expect(checkConvergence([mk(1, 5, { verdict: 'ACCEPT' })])).toBe('critic_accepted');
    expect(checkConvergence([mk(1, 1), mk(2, 5)], 2)).toBe('max_rounds_reached');
    expect(checkConvergence([mk(1, 5), mk(2, 5.2), mk(3, 5.4)])).toBe('score_converged');
    const same = (n: number, t: number) => mk(n, t, { flaws: [{ flaw: 'same', severity: 'HIGH', evidence: '' }] });
    expect(checkConvergence([same(1, 3), same(2, 5), same(3, 7)])).toBe('stalemate_detected');
    expect(checkConvergence([mk(1, 3), mk(2, 5), mk(3, 7)])).toBeNull();
  });

  it('critic parse failures never fake convergence', async () => {
    const { checkConvergence } = await import('../../services/iterative-critique.js');
    const bad = (n: number) => mk(n, 5, { parseFailed: true });
    expect(checkConvergence([bad(1), bad(2), bad(3)])).toBeNull();
  });

  it('bestRound skips parse failures', async () => {
    const { bestRound } = await import('../../services/iterative-critique.js');
    expect(bestRound([mk(1, 6), mk(2, 9, { parseFailed: true }), mk(3, 7)]).round).toBe(3);
  });
});
