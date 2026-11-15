import { describe, it, expect } from 'vitest';
import { advertisedContextWindow } from '../../services/model-listing.js';
import { CONTEXT_WINDOW_SAFETY_FACTOR, fitsContextWindow } from '../../services/router.js';

// #1784: listings advertise the window a request can actually use, so a client
// that fills the advertised window is never turned away by the router's margin.
describe('advertisedContextWindow', () => {
  it('divides the raw window by the router safety factor', () => {
    expect(advertisedContextWindow(128_000)).toBe(Math.floor(128_000 / CONTEXT_WINDOW_SAFETY_FACTOR));
    expect(advertisedContextWindow(4096)).toBe(3276);
  });

  it('keeps unknown windows unknown', () => {
    expect(advertisedContextWindow(null)).toBeNull();
    expect(advertisedContextWindow(undefined)).toBeNull();
    expect(advertisedContextWindow(0)).toBeNull();
  });

  it.each([4096, 32_768, 128_000, 1_000_000])('a request filling the advertised window fits a %i-token model', raw => {
    const advertised = advertisedContextWindow(raw)!;
    expect(fitsContextWindow('test', raw, advertised)).toBe(true);
    expect(fitsContextWindow('test', raw, advertised + Math.ceil(raw * 0.05))).toBe(false);
  });
});
