import { describe, it, expect } from 'vitest';
import { calculateDelay } from '../server/src/services/throttler.js';
import { getPlatformDelayThreshold } from '../server/src/services/provider-limits.js';

// Mock provider limits
const mockProviderLimits = {
  anthropic: {
    rpm: 60,
    tpm: 100000,
    rpd: null,
    tpd: null,
  },
  mistral: {
    rpm: 2,
    tpm: 100000,
    rpd: null,
    tpd: null,
  },
  nvidia: {
    rpm: 40,
    tpm: 100000,
    rpd: null,
    tpd: null,
  }
};

describe('throttler middleware', () => {
  it('should calculate appropriate delay for anthropic', () => {
    const rpmLimit = 60;
    const tpmLimit = 100000;
    const rpmUsed = 70;
    const tpmUsed = 0;
    const threshold = getPlatformDelayThreshold('anthropic');
    const delay = calculateDelay(rpmLimit, tpmLimit, rpmUsed, tpmUsed, threshold);
    console.log(`Anthropic delay: ${delay}ms`);
    expect(delay).toBeGreaterThan(0);
  });

  it('should calculate appropriate delay for mistral', () => {
    const rpmLimit = 2;
    const tpmLimit = 100000;
    const rpmUsed = 3;
    const tpmUsed = 0;
    const threshold = getPlatformDelayThreshold('mistral');
    const delay = calculateDelay(rpmLimit, tpmLimit, rpmUsed, tpmUsed, threshold);
    console.log(`Mistral delay: ${delay}ms`);
    expect(delay).toBeGreaterThan(0);
  });

  it('should calculate appropriate delay for nvidia', () => {
    const rpmLimit = 40;
    const tpmLimit = 100000;
    const rpmUsed = 50;
    const tpmUsed = 0;
    const threshold = getPlatformDelayThreshold('nvidia');
    const delay = calculateDelay(rpmLimit, tpmLimit, rpmUsed, tpmUsed, threshold);
    console.log(`NVIDIA delay: ${delay}ms`);
    expect(delay).toBeGreaterThan(0);
  });

  it('should return 0 delay when usage is below threshold', () => {
    const rpmLimit = 60;
    const tpmLimit = 100000;
    const rpmUsed = 30;
    const tpmUsed = 0;
    const threshold = getPlatformDelayThreshold('anthropic');
    const delay = calculateDelay(rpmLimit, tpmLimit, rpmUsed, tpmUsed, threshold);
    console.log(`Below threshold delay: ${delay}ms`);
    expect(delay).toBe(0);
  });
});