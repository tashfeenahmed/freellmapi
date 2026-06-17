import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getUnconfiguredProviders } from '../../services/provider-nudge.js';

describe('getUnconfiguredProviders', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('lists a provider with enabled models but no key', () => {
    const list = getUnconfiguredProviders();
    const groq = list.find(p => p.platform === 'groq');
    expect(groq).toBeDefined();
    expect(groq!.models).toBeGreaterThan(0);
    expect(typeof groq!.name).toBe('string');
  });

  it('drops a provider once it has an enabled key', () => {
    getDb().prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','x','x','x','x','unknown',1)",
    ).run();
    expect(getUnconfiguredProviders().some(p => p.platform === 'groq')).toBe(false);
  });

  it('excludes keyless providers and unroutable platforms', () => {
    expect(getUnconfiguredProviders().some(p => p.platform === 'pollinations')).toBe(false);
    getDb().prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('bogus','m','M',1,1,1)",
    ).run();
    expect(getUnconfiguredProviders().some(p => p.platform === 'bogus')).toBe(false);
  });
});
