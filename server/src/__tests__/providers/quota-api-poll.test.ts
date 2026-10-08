import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { initDb, getDb } from '../../db/index.js';
import { resolveProvider } from '../../providers/index.js';

// #1403 phase 1: quota_api observations from a provider key-info endpoint.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function makeProvider(spec?: {
  url: string; metric: 'credits'; limitFields: string[]; remainingFields: string[]; notes?: string;
}) {
  return new OpenAICompatProvider({
    platform: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    ...(spec ? { quotaProbe: spec } : {}),
  } as any);
}

function stateRows(platform = 'openrouter') {
  return getDb().prepare(
    'SELECT metric, limit_value, remaining_value, source FROM provider_quota_state WHERE platform = ?',
  ).all(platform) as { metric: string; limit_value: number | null; remaining_value: number | null; source: string }[];
}

describe('fetchQuota — provider-reported quota polling (#1403)', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
    vi.restoreAllMocks();
  });

  it('records limit/remaining from the data-wrapped key-info body as source=quota_api', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { label: 'sk-or-...', limit: 10, limit_remaining: 7.25, usage: 2.75 },
      }),
    } as any);

    const provider = makeProvider({
      url: 'https://openrouter.ai/api/v1/key',
      metric: 'credits',
      limitFields: ['limit'],
      remainingFields: ['limit_remaining'],
    });
    const recorded = await provider.fetchQuota('sk-or-test', {
      platform: 'openrouter', keyId: 42, quotaPoolKey: 'openrouter::account',
    });

    expect(recorded).toBe(true);
    // The probe hits the quota URL, not /models, and sends the key.
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/key');
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-or-test');

    const rows = stateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: 'credits', limit_value: 10, remaining_value: 7.25, source: 'quota_api' });
  });

  it('falls back to the top-level body when there is no data wrapper', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ limit: 100, remaining: 40 }),
    } as any);
    const provider = makeProvider({
      url: 'https://example.test/quota', metric: 'credits',
      limitFields: ['limit'], remainingFields: ['remaining'],
    });
    const ok = await provider.fetchQuota('k', { platform: 'openrouter', keyId: 1 });
    expect(ok).toBe(true);
    const rows = stateRows();
    expect(rows[0]).toMatchObject({ limit_value: 100, remaining_value: 40 });
  });

  it('a provider without a quotaProbe records nothing and does no network', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const provider = makeProvider();
    expect(await provider.fetchQuota('k', { platform: 'openrouter', keyId: 1 })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stateRows()).toHaveLength(0);
  });

  it('never throws: transport errors and error statuses are inconclusive', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('socket hang up'));
    const provider = makeProvider({
      url: 'https://openrouter.ai/api/v1/key', metric: 'credits',
      limitFields: ['limit'], remainingFields: ['limit_remaining'],
    });
    expect(await provider.fetchQuota('k', { platform: 'openrouter', keyId: 1 })).toBe(false);

    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401 } as any);
    expect(await provider.fetchQuota('k', { platform: 'openrouter', keyId: 1 })).toBe(false);
    expect(stateRows()).toHaveLength(0);
  });

  it('a body with no numeric limit/remaining records nothing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ data: { label: 'key', limit: null, limit_remaining: null } }),
    } as any);
    const provider = makeProvider({
      url: 'https://openrouter.ai/api/v1/key', metric: 'credits',
      limitFields: ['limit'], remainingFields: ['limit_remaining'],
    });
    expect(await provider.fetchQuota('k', { platform: 'openrouter', keyId: 1 })).toBe(false);
    expect(stateRows()).toHaveLength(0);
  });

  it('the registered OpenRouter provider carries the /api/v1/key probe', async () => {
    const provider = resolveProvider('openrouter');
    expect(provider).toBeDefined();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ data: { limit: 5, limit_remaining: 4.99 } }),
    } as any);
    getDb().prepare('DELETE FROM provider_quota_state').run();
    const ok = await provider!.fetchQuota('sk-or-x', { platform: 'openrouter', keyId: 7 });
    expect(ok).toBe(true);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/key');
  });

  it('accepts string-encoded balances (SiliconFlow returns "88.88")', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ code: 200, data: { id: 'u', balance: '7.3972', chargeBalance: '15.2505', totalBalance: '22.6478', status: 'normal' } }),
    } as any);
    const provider = makeProvider({
      url: 'https://api.siliconflow.com/v1/user/info', metric: 'credits',
      limitFields: [], remainingFields: ['totalBalance', 'balance'],
    });
    const ok = await provider.fetchQuota('sk-test', { platform: 'openrouter', keyId: 3 });
    expect(ok).toBe(true);
    const rows = stateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: 'credits', limit_value: null, remaining_value: 22.6478, source: 'quota_api' });
  });

  it('a non-numeric string is not a balance', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: { totalBalance: '', balance: null } }),
    } as any);
    const provider = makeProvider({
      url: 'https://api.siliconflow.com/v1/user/info', metric: 'credits',
      limitFields: [], remainingFields: ['totalBalance', 'balance'],
    });
    expect(await provider.fetchQuota('sk-test', { platform: 'openrouter', keyId: 3 })).toBe(false);
    expect(stateRows()).toHaveLength(0);
  });

  it('the registered SiliconFlow provider carries the /v1/user/info probe', async () => {
    const provider = resolveProvider('siliconflow');
    expect(provider).toBeDefined();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ data: { balance: '0.88', totalBalance: '0.88' } }),
    } as any);
    getDb().prepare('DELETE FROM provider_quota_state').run();
    const ok = await provider!.fetchQuota('sk-sf', { platform: 'siliconflow', keyId: 9 });
    expect(ok).toBe(true);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('https://api.siliconflow.com/v1/user/info');
    expect(stateRows('siliconflow')[0]).toMatchObject({ remaining_value: 0.88, source: 'quota_api' });
  });
});
