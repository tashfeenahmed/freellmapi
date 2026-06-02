import { describe, it, expect } from 'vitest';
import { isRetryableError } from '../../routes/proxy.js';

describe('isRetryableError', () => {
  describe('413 Payload Too Large', () => {
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

  describe('404 model removed / not found (the bug #66 fixes)', () => {
    it('treats explicit "404" in the error message as retryable', () => {
      expect(isRetryableError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
      expect(isRetryableError(new Error('Groq API error 404: model not found'))).toBe(true);
    });

    it('catches OpenRouter\'s "No endpoints found" phrasing for deprecated models', () => {
      expect(isRetryableError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
    });

    it('catches bare "not found" phrasing (any provider, any case)', () => {
      expect(isRetryableError(new Error('Model not found'))).toBe(true);
      expect(isRetryableError(new Error('The requested model was not found'))).toBe(true);
    });
  });

  describe('provider tool-call generation 400s fail over (#168)', () => {
    // Groq (and every other openai-compat provider) throws its errors as
    // `${name} API error ${status}: ${msg}`, so a tool-call-generation failure
    // surfaces as "Groq API error 400: Failed to call a function...". That
    // matches the "api error 400" rule, so it's ALREADY retryable and fails
    // over to the next provider — #168 is covered by existing behavior.
    it('treats a Groq failed_generation 400 as retryable', () => {
      expect(isRetryableError(new Error(
        "Groq API error 400: Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
      ))).toBe(true);
    });

    it('treats any openai-compat "API error 400" as retryable (one provider rejects params another accepts)', () => {
      expect(isRetryableError(new Error('Cerebras API error 400: tool schema not supported'))).toBe(true);
    });

    it('but a bare validation "400 Bad Request" (our own schema) is still NOT retryable', () => {
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
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

    it('4xx auth/validation errors are NOT retryable', () => {
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('403 Forbidden'))).toBe(false);
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    });
  });
});
