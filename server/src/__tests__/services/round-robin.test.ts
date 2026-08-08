import { describe, it, expect, afterEach } from 'vitest';
import { nextRoundRobinModel, resetRoundRobinState, trackedComboCount } from '../../services/round-robin.js';

describe('round-robin state', () => {
  afterEach(() => {
    // Reset tracker between tests
    resetRoundRobinState('test-combo');
  });

  it('returns index 0 on first call', () => {
    const idx = nextRoundRobinModel('test-combo', 3, 1);
    expect(idx).toBe(0);
  });

  it('rotates on every request with sticky_limit=1', () => {
    expect(nextRoundRobinModel('test-combo', 3, 1)).toBe(0);
    expect(nextRoundRobinModel('test-combo', 3, 1)).toBe(1);
    expect(nextRoundRobinModel('test-combo', 3, 1)).toBe(2);
    expect(nextRoundRobinModel('test-combo', 3, 1)).toBe(0); // wraps
  });

  it('sticks for sticky_limit requests', () => {
    expect(nextRoundRobinModel('test-combo', 3, 3)).toBe(0);
    expect(nextRoundRobinModel('test-combo', 3, 3)).toBe(0); // still 0
    expect(nextRoundRobinModel('test-combo', 3, 3)).toBe(0); // still 0
    expect(nextRoundRobinModel('test-combo', 3, 3)).toBe(1); // rotates
  });

  it('handles single-model combos', () => {
    expect(nextRoundRobinModel('test-combo', 1, 5)).toBe(0);
    expect(nextRoundRobinModel('test-combo', 1, 5)).toBe(0);
    expect(nextRoundRobinModel('test-combo', 1, 5)).toBe(0);
  });

  it('manages separate state per combo name', () => {
    expect(nextRoundRobinModel('combo-a', 2, 1)).toBe(0);
    expect(nextRoundRobinModel('combo-b', 2, 1)).toBe(0);
    expect(nextRoundRobinModel('combo-a', 2, 1)).toBe(1); // a rotated independently
    expect(nextRoundRobinModel('combo-b', 2, 1)).toBe(1); // b rotated independently
  });

  it('reset clears state', () => {
    expect(nextRoundRobinModel('test-combo', 5, 1)).toBe(0);
    expect(nextRoundRobinModel('test-combo', 5, 1)).toBe(1);
    resetRoundRobinState('test-combo');
    expect(nextRoundRobinModel('test-combo', 5, 1)).toBe(0); // back to start
  });
});
