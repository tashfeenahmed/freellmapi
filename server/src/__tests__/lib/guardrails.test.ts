import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit tests for the request guardrails (ported from @coffcoe's fork): the
// per-request token budget (pre-flight reject / cap-absent-max_tokens) and
// the consecutive-upstream-failure circuit breaker, plus the
// setting → env → 0 precedence of both knobs.

// Mock the settings store so the getters can be driven deterministically.
const settingStore = new Map<string, string>();
vi.mock('../../db/index.js', () => ({
  getSetting: (key: string) => settingStore.get(key),
}));

import {
  getRequestMaxTokensBudget,
  getMaxConsecutiveUpstreamFails,
  applyTokenBudget,
  tokenBudgetMessage,
  newBreaker,
  recordBreakerFailure,
  REQUEST_MAX_TOKENS_BUDGET_SETTING,
  MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING,
  TOKEN_BUDGET_OUTPUT_CAP,
} from '../../lib/guardrails.js';

beforeEach(() => {
  settingStore.clear();
});

afterEach(() => {
  delete process.env.REQUEST_MAX_TOKENS_BUDGET;
  delete process.env.MAX_CONSECUTIVE_UPSTREAM_FAILS;
});

describe('guardrail setting getters (setting → env → 0)', () => {
  it('default to 0 (disabled) when nothing is configured', () => {
    expect(getRequestMaxTokensBudget()).toBe(0);
    expect(getMaxConsecutiveUpstreamFails()).toBe(0);
  });

  it('read the settings-table value', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8000');
    settingStore.set(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, '5');
    expect(getRequestMaxTokensBudget()).toBe(8000);
    expect(getMaxConsecutiveUpstreamFails()).toBe(5);
  });

  it('fall back to the env var when the setting is unset', () => {
    process.env.REQUEST_MAX_TOKENS_BUDGET = '4096';
    process.env.MAX_CONSECUTIVE_UPSTREAM_FAILS = '3';
    expect(getRequestMaxTokensBudget()).toBe(4096);
    expect(getMaxConsecutiveUpstreamFails()).toBe(3);
  });

  it('the settings-table value wins over the env var', () => {
    process.env.REQUEST_MAX_TOKENS_BUDGET = '4096';
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '100');
    expect(getRequestMaxTokensBudget()).toBe(100);
  });

  it('treats garbage, negative, and non-integer values as unset (fail-safe off)', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, 'abc');
    expect(getRequestMaxTokensBudget()).toBe(0);
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '-5');
    expect(getRequestMaxTokensBudget()).toBe(0);
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8.5');
    expect(getRequestMaxTokensBudget()).toBe(0);
  });

  it('a garbage setting falls through to a valid env var', () => {
    settingStore.set(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, 'lots');
    process.env.MAX_CONSECUTIVE_UPSTREAM_FAILS = '7';
    expect(getMaxConsecutiveUpstreamFails()).toBe(7);
  });
});

describe('applyTokenBudget', () => {
  it('passes everything through untouched when the budget is disabled', () => {
    expect(applyTokenBudget(1_000_000, undefined)).toEqual({ rejection: null, maxTokens: undefined });
    expect(applyTokenBudget(1_000_000, 32_000)).toEqual({ rejection: null, maxTokens: 32_000 });
  });

  it('rejects when estimated input + requested output exceeds the budget', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8000');
    const r = applyTokenBudget(5000, 4000);
    expect(r.rejection).toEqual({ budget: 8000, estimatedTotal: 9000 });
  });

  it('an exact fit passes', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8000');
    expect(applyTokenBudget(5000, 3000)).toEqual({ rejection: null, maxTokens: 3000 });
  });

  it('caps an absent max_tokens to the budget remainder instead of rejecting', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8000');
    expect(applyTokenBudget(5000, undefined)).toEqual({ rejection: null, maxTokens: 3000 });
  });

  it('clamps the injected max_tokens to the output cap under a generous budget', () => {
    // Regression: budget 100000 minus a 1000-token prompt forwarded
    // max_tokens=99000 verbatim, and providers that validate max_tokens
    // against the model's limits 400'd every candidate in the chain.
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '100000');
    expect(applyTokenBudget(1000, undefined)).toEqual({ rejection: null, maxTokens: TOKEN_BUDGET_OUTPUT_CAP });
    // A client-set max_tokens is never rewritten, only validated.
    expect(applyTokenBudget(1000, 50_000)).toEqual({ rejection: null, maxTokens: 50_000 });
  });

  it('rejects an absent max_tokens when the input alone fills the budget', () => {
    settingStore.set(REQUEST_MAX_TOKENS_BUDGET_SETTING, '8000');
    expect(applyTokenBudget(8000, undefined).rejection).toEqual({ budget: 8000, estimatedTotal: 8000 });
    expect(applyTokenBudget(9000, undefined).rejection).toEqual({ budget: 8000, estimatedTotal: 9000 });
  });

  it('tokenBudgetMessage names the numbers and the setting', () => {
    const msg = tokenBudgetMessage({ budget: 8000, estimatedTotal: 9000 });
    expect(msg).toContain('9000');
    expect(msg).toContain('8000');
    expect(msg).toContain(REQUEST_MAX_TOKENS_BUDGET_SETTING);
  });
});

describe('circuit breaker state machine', () => {
  it('never trips when disabled (limit 0)', () => {
    const b = newBreaker(0);
    expect(recordBreakerFailure(b)).toBe(false);
    expect(recordBreakerFailure(b)).toBe(false);
    expect(b.consecutive).toBe(0);
  });

  it('trips exactly on the Nth failure', () => {
    const b = newBreaker(3);
    expect(recordBreakerFailure(b)).toBe(false);
    expect(recordBreakerFailure(b)).toBe(false);
    expect(recordBreakerFailure(b)).toBe(true);
    expect(b.consecutive).toBe(3);
  });

  it('newBreaker defaults its limit from the setting', () => {
    settingStore.set(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, '2');
    const b = newBreaker();
    expect(b.limit).toBe(2);
    expect(recordBreakerFailure(b)).toBe(false);
    expect(recordBreakerFailure(b)).toBe(true);
  });
});
