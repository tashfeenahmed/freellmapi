import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWakeDetect, stopWakeDetect, _resetForTests } from '../../lib/wake-detect.js';

// Ported with the module from @Naster17's fork (freellmapi-pro@4c43cf2a);
// the drift test is ours (his suite only covered the signal path).

describe('wake-detect', () => {
  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopWakeDetect();
  });

  it('installs idempotently (no double signal registration)', () => {
    const before = process.listenerCount('SIGCONT');
    startWakeDetect({ onWake: vi.fn() });
    startWakeDetect({ onWake: vi.fn() });
    expect(process.listenerCount('SIGCONT')).toBe(before + 1);
  });

  it('unregisters signal listeners on stop and drops the hooks reference', () => {
    const onWake = vi.fn();
    const before = process.listenerCount('SIGUSR2');
    startWakeDetect({ onWake });
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
    stopWakeDetect();
    expect(process.listenerCount('SIGUSR2')).toBe(before);
    process.emit('SIGCONT' as any);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('a signal triggers a wake event naming the signal', () => {
    const onWake = vi.fn();
    startWakeDetect({ onWake });
    process.emit('SIGUSR2' as any);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0][0]).toMatchObject({ reason: 'signal', signal: 'SIGUSR2' });
  });

  it('debounces wake events: one recovery pass per resume, not one per signal', () => {
    // A drift tick and an operator SIGCONT for the SAME wake (or signal spam)
    // used to stack full key re-probes on top of each other.
    const onWake = vi.fn();
    startWakeDetect({ onWake });
    process.emit('SIGUSR2' as any);
    process.emit('SIGCONT' as any);
    process.emit('SIGUSR2' as any);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('stop removes only its OWN signal listeners, not other modules’', () => {
    // removeAllListeners('SIGUSR2') silently unhooked any other registrant
    // (log rotation, heap-dump triggers).
    const foreign = vi.fn();
    process.on('SIGUSR2', foreign);
    startWakeDetect({ onWake: vi.fn() });
    stopWakeDetect();
    process.emit('SIGUSR2' as any);
    expect(foreign).toHaveBeenCalledTimes(1);
    process.removeListener('SIGUSR2', foreign);
  });

  it('fires a drift wake when the wall clock jumps past the threshold (host suspend)', () => {
    vi.useFakeTimers();
    const onWake = vi.fn();
    startWakeDetect({ onWake });

    vi.advanceTimersByTime(5_000); // baseline tick, no drift
    expect(onWake).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 120_000); // the suspend: clock jumps 2 minutes
    vi.advanceTimersByTime(5_000); // next tick observes the jump

    expect(onWake).toHaveBeenCalledTimes(1);
    const event = onWake.mock.calls[0][0];
    expect(event.reason).toBe('drift');
    expect(event.idleMs).toBeGreaterThanOrEqual(120_000);
  });

  it('normal ticking never fires (no false positives)', () => {
    vi.useFakeTimers();
    const onWake = vi.fn();
    startWakeDetect({ onWake });
    vi.advanceTimersByTime(60_000); // 12 ordinary ticks
    expect(onWake).not.toHaveBeenCalled();
  });

  it('a throwing onWake handler is logged, not fatal', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startWakeDetect({ onWake: () => { throw new Error('boom'); } });
    process.emit('SIGCONT' as any);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a rejecting async onWake handler is logged, not fatal', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startWakeDetect({ onWake: async () => { throw new Error('async boom'); } });
    process.emit('SIGCONT' as any);
    await new Promise(r => setImmediate(r));
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
