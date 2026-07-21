import { describe, it, expect } from 'vitest';
import { sanitizeProviderErrorMessage } from '../../lib/error-redaction.js';

describe('sanitizeProviderErrorMessage', () => {
  it('redacts Bearer tokens', () => {
    expect(sanitizeProviderErrorMessage('auth failed: Bearer abc.def-123')).toBe(
      'auth failed: Bearer [redacted]',
    );
  });

  it('redacts labeled secrets in plain form', () => {
    expect(sanitizeProviderErrorMessage('api_key=supersecretvalue rejected')).toBe(
      'api_key=[redacted] rejected',
    );
  });

  it('redacts JSON-quoted secret labels', () => {
    const out = sanitizeProviderErrorMessage('upstream said {"api_key": "supersecretvalue123"}');
    expect(out).not.toContain('supersecretvalue123');
    expect(out).toContain('"api_key": "[redacted]');
  });

  it('redacts bare high-entropy tokens with no known prefix', () => {
    const out = sanitizeProviderErrorMessage('key co-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 was rejected');
    expect(out).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    expect(out).toContain('[redacted-token]');
  });

  it('redacts URLs including key-bearing query strings', () => {
    const out = sanitizeProviderErrorMessage('GET https://api.example.com/v1?key=sk-abc123 failed');
    expect(out).not.toContain('api.example.com');
    expect(out).toContain('[redacted-url]');
  });

  it('leaves ordinary provider prose and model ids intact', () => {
    const msg = 'model llama-3.3-70b-versatile is over capacity, retry after 30s (HTTP 429)';
    expect(sanitizeProviderErrorMessage(msg)).toBe(msg);
  });

  it('caps message length', () => {
    const out = sanitizeProviderErrorMessage('x '.repeat(400));
    expect(out.length).toBeLessThanOrEqual(240);
  });
});
