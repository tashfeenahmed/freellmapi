import { describe, it, expect } from 'vitest';
import { isRetryableError } from '../../routes/proxy.js';

describe('isRetryableError', () => {
  describe('413 Payload Too Large (the bug this PR fixes)', () => {
    it('treats explicit "413" in the error message as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 413: Request body too large'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 413: Payload Too Large'))).toBe(true);
    });

    it('treats common 413 phrasings (no status code) as retryable', () => {
      expect(isRetryableError(new Error('Payload Too Large'))).toBe(true);
      expect(isRetryableError(new Error('Request body too large for this model'))).toBe(true);
      expect(isRetryableError(new Error('Request entity too large'))).toBe(true);
      expect(isRetryableError(new Error('Content too large'))).toBe(true);
    });
  });

  describe('existing categories still classify correctly', () => {
    it('429 / rate limits are retryable', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('quota exhausted'))).toBe(true);
    });

    it('5xx and network errors are retryable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('4xx other than 413/429 are NOT retryable', () => {
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
      expect(isRetryableError(new Error('404 Not Found'))).toBe(false);
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
    });
  });
});
