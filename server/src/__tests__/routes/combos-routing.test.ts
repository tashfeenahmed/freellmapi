import { describe, it, expect, afterEach } from 'vitest';
import { nextRoundRobinModel, resetRoundRobinState } from '../../services/round-robin.js';

describe('combo request routing (integration)', () => {
  afterEach(() => {
    resetRoundRobinState('e2e-test-combo');
  });

  it('round-robin rotation works through the combo service integration', () => {
    // Simulate 2-model combo with sticky_limit=1
    const modelCount = 2;
    const stickyLimit = 1;

    // First request → model 0
    expect(nextRoundRobinModel('e2e-test-combo', modelCount, stickyLimit)).toBe(0);
    // Second request → model 1
    expect(nextRoundRobinModel('e2e-test-combo', modelCount, stickyLimit)).toBe(1);
    // Third request → wraps to model 0
    expect(nextRoundRobinModel('e2e-test-combo', modelCount, stickyLimit)).toBe(0);
  });

  it('handles sticky_limit > 1', () => {
    expect(nextRoundRobinModel('e2e-test-combo', 3, 2)).toBe(0);
    expect(nextRoundRobinModel('e2e-test-combo', 3, 2)).toBe(0); // sticks
    expect(nextRoundRobinModel('e2e-test-combo', 3, 2)).toBe(1); // rotates
    expect(nextRoundRobinModel('e2e-test-combo', 3, 2)).toBe(1); // sticks
    expect(nextRoundRobinModel('e2e-test-combo', 3, 2)).toBe(2); // rotates
  });
});
