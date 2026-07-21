import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STREAM_STALL_TIMEOUT_MS,
  providerTimeoutEnvName,
  providerTimeoutMs,
  resetTimeoutWarnings,
  streamStallTimeoutMs,
} from '../../lib/provider-timeout.js';

// Per-provider timeout overrides (issue #547, reworked from PR #509).

afterEach(() => {
  delete process.env.PROVIDER_TIMEOUT_NVIDIA;
  delete process.env.PROVIDER_TIMEOUT_GROQ;
  delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS;
  resetTimeoutWarnings();
  vi.restoreAllMocks();
});

describe('providerTimeoutEnvName', () => {
  it('upper-cases the platform', () => {
    expect(providerTimeoutEnvName('nvidia')).toBe('PROVIDER_TIMEOUT_NVIDIA');
    expect(providerTimeoutEnvName('aihorde')).toBe('PROVIDER_TIMEOUT_AIHORDE');
  });
});

describe('providerTimeoutMs', () => {
  it('returns the built-in default when the env var is unset', () => {
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(90_000);
  });

  it('lets the env override win over the default', () => {
    process.env.PROVIDER_TIMEOUT_NVIDIA = '300000';
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(300_000);
  });

  it('accepts 0 as "no timeout"', () => {
    process.env.PROVIDER_TIMEOUT_NVIDIA = '0';
    expect(providerTimeoutMs('nvidia', 90_000)).toBe(0);
  });

  it('ignores negative, fractional, and non-numeric values (warns once, keeps default)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['-1', '1.5', 'ninety', '']) {
      process.env.PROVIDER_TIMEOUT_NVIDIA = bad;
      expect(providerTimeoutMs('nvidia', 90_000)).toBe(90_000);
    }
    // '' is treated as unset (no warning); the three malformed values share one
    // env name, so the warn-once gate fires exactly once.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns on sub-second values that would abort nearly every request, but honors them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROVIDER_TIMEOUT_GROQ = '500';
    expect(providerTimeoutMs('groq', 60_000)).toBe(500);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('streamStallTimeoutMs', () => {
  it('defaults to 90s', () => {
    expect(streamStallTimeoutMs()).toBe(DEFAULT_STREAM_STALL_TIMEOUT_MS);
  });

  it('honors PROVIDER_STREAM_STALL_TIMEOUT_MS, including 0 to disable the watchdog', () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '240000';
    expect(streamStallTimeoutMs()).toBe(240_000);
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '0';
    expect(streamStallTimeoutMs()).toBe(0);
  });
});
