import { describe, it, expect } from 'vitest';
import { inferQuotaPoolKey } from '../../services/provider-quota.js';

describe('inferQuotaPoolKey', () => {
  it('splits openrouter into free vs account pools based on the model suffix', () => {
    expect(inferQuotaPoolKey('openrouter', 'some-model:free')).toBe('openrouter::free');
    expect(inferQuotaPoolKey('openrouter', 'some-model')).toBe('openrouter::account');
    expect(inferQuotaPoolKey('openrouter', null)).toBe('openrouter::account');
  });

  it('maps known platforms to their fixed shared pool key', () => {
    expect(inferQuotaPoolKey('google', 'gemini-pro')).toBe('google::project');
    expect(inferQuotaPoolKey('groq', null)).toBe('groq::account');
    expect(inferQuotaPoolKey('cerebras', null)).toBe('cerebras::shared');
    expect(inferQuotaPoolKey('huggingface', null)).toBe('huggingface::router');
  });

  it('falls back to platform::modelId for unrecognized platforms with a model', () => {
    expect(inferQuotaPoolKey('unknown-platform' as any, 'model-x')).toBe('unknown-platform::model-x');
  });

  it('falls back to platform::account for unrecognized platforms without a model', () => {
    expect(inferQuotaPoolKey('unknown-platform' as any, null)).toBe('unknown-platform::account');
    expect(inferQuotaPoolKey('unknown-platform' as any, undefined)).toBe('unknown-platform::account');
    expect(inferQuotaPoolKey('unknown-platform' as any, '  ')).toBe('unknown-platform::account');
  });
});
