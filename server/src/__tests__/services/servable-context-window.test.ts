import { describe, it, expect } from 'vitest';
import { servableContextWindow } from '../../services/model-listing.js';

// #1717: auto, named chains and unify groups advertise the window most of
// their models hold, not the single largest one.
describe('servableContextWindow', () => {
  it('is null when no window is known', () => {
    expect(servableContextWindow([])).toBeNull();
    expect(servableContextWindow([null, undefined])).toBeNull();
  });

  it('is the window itself for a single model', () => {
    expect(servableContextWindow([131_072])).toBe(131_072);
  });

  it('does not let one 1M model set the advertised window', () => {
    expect(servableContextWindow([1_048_576, 131_072, 131_072, 32_768])).toBe(131_072);
    expect(servableContextWindow([1_048_576, 131_072])).toBe(131_072);
  });

  it('advertises a large window when most models hold it', () => {
    expect(servableContextWindow([1_048_576, 1_048_576, 1_048_576, 131_072])).toBe(1_048_576);
  });

  it('ignores unknown windows', () => {
    expect(servableContextWindow([null, 200_000, null, 128_000, 64_000])).toBe(128_000);
  });
});
