import { describe, it, expect, vi, beforeEach } from 'vitest';

// The unified output-token cap: an operator-level ceiling on max_tokens that
// applies to every client. Open WebUI sends max_tokens=65536 by default, which
// 400s against free models whose output limit is 32768 — and the invalid value
// rides every failover hop, so the chain can't rescue the request.

// Mock the settings store so the cap can be driven deterministically, the same
// way guardrails.test.ts drives its knobs.
const settingStore = new Map<string, string>();
vi.mock('../../db/index.js', () => ({
  getSetting: (key: string) => settingStore.get(key),
}));

import {
  unifiedMaxTokensCap,
  resolveMaxTokens,
  defaultMaxTokensFor,
  maxTokensCapFor,
  UNIFIED_MAX_TOKENS_SETTING,
  UNIFIED_MAX_TOKENS_AUTO,
} from '../../lib/sampling-params.js';

beforeEach(() => {
  settingStore.clear();
});

describe('unifiedMaxTokensCap', () => {
  it('is disabled when the setting is unset', () => {
    expect(unifiedMaxTokensCap()).toBeNull();
  });

  it("is disabled for 'off', '0' and an empty value", () => {
    for (const raw of ['off', 'OFF', ' off ', '0', '', '   ']) {
      settingStore.set(UNIFIED_MAX_TOKENS_SETTING, raw);
      expect(unifiedMaxTokensCap()).toBeNull();
    }
  });

  it("resolves 'auto' to the auto ceiling, case- and space-insensitively", () => {
    for (const raw of ['auto', 'AUTO', ' Auto ']) {
      settingStore.set(UNIFIED_MAX_TOKENS_SETTING, raw);
      expect(unifiedMaxTokensCap()).toBe(UNIFIED_MAX_TOKENS_AUTO);
    }
  });

  it('uses an explicit positive integer verbatim', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, '4096');
    expect(unifiedMaxTokensCap()).toBe(4096);
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, ' 1 ');
    expect(unifiedMaxTokensCap()).toBe(1);
  });

  it('treats garbage as disabled so a bad value can never 400 requests', () => {
    for (const raw of ['banana', '-1', '1.5', 'NaN', 'Infinity', '32k', '{}']) {
      settingStore.set(UNIFIED_MAX_TOKENS_SETTING, raw);
      expect(unifiedMaxTokensCap()).toBeNull();
    }
  });
});

describe('resolveMaxTokens under the cap', () => {
  it('passes everything through untouched when the cap is disabled', () => {
    expect(resolveMaxTokens('groq', 65536)).toBe(65536);
    expect(resolveMaxTokens('groq', undefined)).toBeUndefined();
    expect(resolveMaxTokens('cloudflare', undefined)).toBe(defaultMaxTokensFor('cloudflare'));
  });

  it('lowers a requested value that exceeds the cap', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, 'auto');
    expect(resolveMaxTokens('groq', 65536)).toBe(UNIFIED_MAX_TOKENS_AUTO);
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, '4096');
    expect(resolveMaxTokens('groq', 65536)).toBe(4096);
  });

  it('leaves a requested value at or below the cap alone', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, '4096');
    expect(resolveMaxTokens('groq', 1024)).toBe(1024);
    expect(resolveMaxTokens('groq', 4096)).toBe(4096);
  });

  it('clamps the platform default when the client sent nothing', () => {
    const cfDefault = defaultMaxTokensFor('cloudflare')!;
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, String(cfDefault - 1));
    expect(resolveMaxTokens('cloudflare', undefined)).toBe(cfDefault - 1);
  });

  it('still sends nothing for a platform with no default and no client value', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, 'auto');
    expect(resolveMaxTokens('groq', undefined)).toBeUndefined();
  });

  it('never raises a value below the cap up to it', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, '100000');
    expect(resolveMaxTokens('cloudflare', undefined)).toBe(defaultMaxTokensFor('cloudflare'));
    expect(resolveMaxTokens('groq', 16)).toBe(16);
  });
});

describe('per-platform max_tokens ceiling', () => {
  it('is no longer declared once GitHub Models retired (#877)', () => {
    expect(maxTokensCapFor('github')).toBeUndefined();
    expect(maxTokensCapFor('groq')).toBeUndefined();
    expect(maxTokensCapFor('nonsense-platform')).toBeUndefined();
  });

  it('passes an oversized request through when no platform cap applies', () => {
    expect(unifiedMaxTokensCap()).toBeNull();
    expect(resolveMaxTokens('github', 65536)).toBe(65536);
    // Other platforms keep the historical pass-through behaviour.
    expect(resolveMaxTokens('groq', 65536)).toBe(65536);
  });

  it('leaves a request alone when no platform ceiling exists', () => {
    expect(resolveMaxTokens('github', 128)).toBe(128);
  });

  it('sends nothing when the client sent nothing and the platform has no floor', () => {
    expect(resolveMaxTokens('github', undefined)).toBeUndefined();
  });

  it('applies only the operator cap when no platform cap exists', () => {
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, 'auto'); // 32768 — looser
    expect(resolveMaxTokens('github', 65536)).toBe(32768);
    settingStore.set(UNIFIED_MAX_TOKENS_SETTING, '128'); // tighter
    expect(resolveMaxTokens('github', 65536)).toBe(128);
  });
});
