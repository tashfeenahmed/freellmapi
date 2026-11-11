import { describe, expect, it } from 'vitest';
import { isModelNotFoundError, isRetryableError } from '../../lib/error-classify.js';

describe('HTTP error codes in free-form provider errors', () => {
  it.each(['14041', '14100', '14290', '15000', '15030', '14130'])(
    'does not treat token count %s as an HTTP error code', count => {
      const err = Object.assign(new Error(`Requested ${count} tokens`), { status: 400 });
      expect(isModelNotFoundError(err)).toBe(false);
      expect(isRetryableError(err)).toBe(false);
      expect(isModelNotFoundError(new Error(`Requested ${count} tokens`))).toBe(false);
      expect(isRetryableError(new Error(`Requested ${count} tokens`))).toBe(false);
    },
  );

  it.each([404, 410])('treats structured status %s as model-not-found', status => {
    const err = Object.assign(new Error('upstream rejected request'), { status });
    expect(isModelNotFoundError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it.each([404, 410])('recognizes standalone status %s when no status is attached', status => {
    const err = new Error(`Provider HTTP ${status}`);
    expect(isModelNotFoundError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it('treats status zero as an absent HTTP status', () => {
    const err = Object.assign(new Error('Provider HTTP 404'), { status: 0 });
    expect(isModelNotFoundError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
  });

  it.each([404, 410])('does not override another structured status with a text code %s', code => {
    const err = Object.assign(new Error(`response mentioned ${code}`), { status: 400 });
    expect(isModelNotFoundError(err)).toBe(false);
    expect(isRetryableError(err)).toBe(false);
  });

  it.each([429, 500, 503, 413])('still recognizes a standalone retryable code %s', status => {
    expect(isRetryableError(new Error(`Provider HTTP ${status}`))).toBe(true);
  });

  it('preserves explicit model-not-found wording even on status 400', () => {
    const err = Object.assign(new Error('No model found: test-model'), { status: 400 });
    expect(isModelNotFoundError(err)).toBe(true);
  });
});
