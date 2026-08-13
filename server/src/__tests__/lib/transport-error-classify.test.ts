import { describe, it, expect } from 'vitest';

// 2026-08 live incident (deepseek-code combo via SOCKS proxy): three
// consecutive requests died at attempt a0 with undici's raw
// "Client network socket disconnected before secure TLS connection was
// established" — classified fatal because isRetryableError's substring rules
// only saw the top-level message and never walked err.cause, so the client
// got the error while 11 healthy models sat unused in the fallback chain.
// The fix: a cause-chain transport classifier (isTransportError) wired into
// isRetryableError.

import { isRetryableError, isTransportError } from '../../lib/error-classify.js';

function withCode(code: string, message = 'socket error'): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

function wrappedInFetchFailed(cause: Error): TypeError {
  const err = new TypeError('fetch failed');
  (err as any).cause = cause;
  return err;
}

describe('isTransportError', () => {
  it('matches the raw undici TLS-handshake disconnect wording', () => {
    const err = new Error('Client network socket disconnected before secure TLS connection was established');
    expect(isTransportError(err)).toBe(true);
  });

  it('walks the cause chain (undici wraps the socket error as err.cause)', () => {
    const socketErr = new Error('Client network socket disconnected before secure TLS connection was established');
    expect(isTransportError(wrappedInFetchFailed(socketErr))).toBe(true);
  });

  it('matches nested cause chains', () => {
    const inner = withCode('UND_ERR_SOCKET');
    const mid = new Error('intermediate');
    (mid as any).cause = inner;
    expect(isTransportError(wrappedInFetchFailed(mid))).toBe(true);
  });

  it('matches Node socket error codes on the top-level error', () => {
    expect(isTransportError(withCode('ECONNRESET'))).toBe(true);
    expect(isTransportError(withCode('ETIMEDOUT'))).toBe(true);
    expect(isTransportError(withCode('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('is false for ordinary provider errors', () => {
    expect(isTransportError(new Error('Groq API error 400: max_tokens must be a positive integer'))).toBe(false);
    expect(isTransportError(null)).toBe(false);
  });
});

describe('isRetryableError + transport failures', () => {
  it('classifies the raw TLS-disconnect message as retryable', () => {
    const err = new Error('Client network socket disconnected before secure TLS connection was established');
    expect(isRetryableError(err)).toBe(true);
  });

  it('classifies the undici wrapped form (fetch failed + cause) as retryable', () => {
    const socketErr = new Error('Client network socket disconnected before secure TLS connection was established');
    expect(isRetryableError(wrappedInFetchFailed(socketErr))).toBe(true);
  });

  it('classifies UND_ERR_SOCKET-coded errors as retryable', () => {
    expect(isRetryableError(withCode('UND_ERR_SOCKET'))).toBe(true);
  });

  it('does not regress: bare validation 400 stays non-retryable', () => {
    expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
  });

  it('does not regress: client abort stays non-retryable', () => {
    const err = new Error('client disconnected — upstream request canceled');
    expect(isRetryableError(err)).toBe(false);
  });

  it('does not regress: structured 429 stays retryable', () => {
    const err = new Error('rate limited') as Error & { status?: number };
    err.status = 429;
    expect(isRetryableError(err)).toBe(true);
  });
});
