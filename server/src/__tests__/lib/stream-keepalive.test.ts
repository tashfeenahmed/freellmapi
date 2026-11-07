import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamKeepaliveMs, startStreamKeepalive } from '../../lib/stream-keepalive.js';

// #1642: SSE keep-alive pings for the uncommitted streaming window. The
// helper carries the env parsing and the timer lifecycle; the route pumps
// wire it to a real response (covered by proxy-stream-keepalive.test.ts).

describe('streamKeepaliveMs (#1642)', () => {
  it('defaults to 0 (feature off) when STREAM_KEEPALIVE_MS is unset or blank', () => {
    expect(streamKeepaliveMs({})).toBe(0);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '' })).toBe(0);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '   ' })).toBe(0);
  });

  it('treats 0, negatives, and garbage as off', () => {
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '0' })).toBe(0);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '-5' })).toBe(0);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: 'abc' })).toBe(0);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: 'Infinity' })).toBe(0);
  });

  it('accepts a positive interval and floors it at 1s', () => {
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '15000' })).toBe(15000);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '1e9' })).toBe(1e9);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '5' })).toBe(1000);
    expect(streamKeepaliveMs({ STREAM_KEEPALIVE_MS: '2500.7' })).toBe(2500);
  });
});

describe('startStreamKeepalive (#1642)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing when the interval is 0 (no timer is created)', () => {
    const keepalive = vi.fn();
    const stop = startStreamKeepalive(0, () => false, keepalive);
    vi.advanceTimersByTime(10_000);
    expect(keepalive).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('fires on each tick until the attempt settles', () => {
    let done = false;
    const keepalive = vi.fn();
    startStreamKeepalive(1000, () => done, keepalive);
    vi.advanceTimersByTime(3500);
    expect(keepalive).toHaveBeenCalledTimes(3);
    done = true;
    vi.advanceTimersByTime(5000);
    expect(keepalive).toHaveBeenCalledTimes(3);
  });

  it('stops after a write failure (dead socket)', () => {
    const keepalive = vi.fn(() => { throw new Error('socket gone'); });
    startStreamKeepalive(1000, () => false, keepalive);
    vi.advanceTimersByTime(5000);
    expect(keepalive).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent and prevents further ticks', () => {
    const keepalive = vi.fn();
    const stop = startStreamKeepalive(1000, () => false, keepalive);
    vi.advanceTimersByTime(1500);
    expect(keepalive).toHaveBeenCalledTimes(1);
    stop();
    stop();
    vi.advanceTimersByTime(5000);
    expect(keepalive).toHaveBeenCalledTimes(1);
  });
});
