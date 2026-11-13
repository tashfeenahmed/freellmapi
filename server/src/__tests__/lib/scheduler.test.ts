import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeScheduler } from '../../lib/scheduler.js';

// M39: shutdown stops every background job before it closes the database, so
// none of them fires during the drain and touches a closing DB.
describe('NodeScheduler.stopAll', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('cancels every interval and timeout it handed out', () => {
    vi.useFakeTimers();
    const scheduler = new NodeScheduler();
    const every = vi.fn();
    const after = vi.fn();
    scheduler.every(1_000, every);
    scheduler.after(1_000, after);

    scheduler.stopAll();
    vi.advanceTimersByTime(5_000);

    expect(every).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('starts nothing once stopped', () => {
    vi.useFakeTimers();
    const scheduler = new NodeScheduler();
    scheduler.stopAll();
    const late = vi.fn();
    scheduler.every(1_000, late);
    scheduler.after(1_000, late);

    vi.advanceTimersByTime(5_000);
    expect(late).not.toHaveBeenCalled();
  });

  it('keeps per-job cancel working', () => {
    vi.useFakeTimers();
    const scheduler = new NodeScheduler();
    const fn = vi.fn();
    const cancel = scheduler.every(1_000, fn);
    vi.advanceTimersByTime(1_000);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
