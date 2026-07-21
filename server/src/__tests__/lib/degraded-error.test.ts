import { describe, it, expect, beforeAll, vi } from 'vitest';

// Issue #522: NVIDIA NIM reports a temporarily-degraded hosted deployment as
// `400 {"detail":"Function id '...': DEGRADED function cannot be invoked"}`.
// That is provider health, not request shape — it must stay retryable, must
// NOT classify as provider_bad_request, and an exhausted chain must render a
// 503, never a client-blaming 400 invalid_request_error.

vi.mock('../../services/health.js', () => ({ checkKeyHealth: vi.fn() }));

import { initDb } from '../../db/index.js';
import {
  isProviderBadRequestError,
  isProviderDegradedError,
  isRetryableError,
} from '../../lib/error-classify.js';
import { classifyAttemptError, exhaustedRetryError } from '../../lib/fallback-loop.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function nimDegraded400(): Error & { status?: number } {
  const err = new Error(
    "NVIDIA NIM API error 400: Function id 'abc-123': DEGRADED function cannot be invoked",
  ) as Error & { status?: number };
  err.status = 400;
  return err;
}

function plainBadRequest400(): Error & { status?: number } {
  const err = new Error('Groq API error 400: max_tokens must be a positive integer') as Error & { status?: number };
  err.status = 400;
  return err;
}

describe('isProviderDegradedError', () => {
  it('matches the NIM DEGRADED-function 400 shape', () => {
    expect(isProviderDegradedError(nimDegraded400())).toBe(true);
  });

  it('does not match an ordinary provider 400', () => {
    expect(isProviderDegradedError(plainBadRequest400())).toBe(false);
  });
});

describe('degraded 400 classification', () => {
  it('stays retryable so the failover chain continues', () => {
    expect(isRetryableError(nimDegraded400())).toBe(true);
  });

  it('is excluded from provider_bad_request', () => {
    expect(isProviderBadRequestError(nimDegraded400())).toBe(false);
    expect(isProviderBadRequestError(plainBadRequest400())).toBe(true);
  });

  it('shows up as upstream_error in the attempt trail', () => {
    expect(classifyAttemptError(nimDegraded400())).toBe('upstream_error');
    expect(classifyAttemptError(plainBadRequest400())).toBe('provider_bad_request');
  });
});

describe('exhaustedRetryError on a degraded last error', () => {
  it('renders 503 service_unavailable instead of 400 invalid_request_error', () => {
    const body = exhaustedRetryError(nimDegraded400(), 3);
    expect(body.status).toBe(503);
    expect(body.type).toBe('service_unavailable');
    expect(body.kind).toBe('unavailable');
    expect(body.message).toContain('degraded');
  });

  it('still renders 400 invalid_request_error for a genuine whole-chain bad request', () => {
    const body = exhaustedRetryError(plainBadRequest400(), 3);
    expect(body.status).toBe(400);
    expect(body.type).toBe('invalid_request_error');
  });
});
