import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; init: RequestInit }> = [];
let livez: { status: number; body: unknown };
let output: string;

beforeEach(() => {
  livez = { status: 200, body: { status: 'ok', version: '1.2.3', uptime_s: 5, stored_keys_decryptable: true } };
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, init });
    if (path === '/livez') return Response.json(livez.body, { status: livez.status });
    if (path === '/api/keys') return Response.json([
      { id: 1, platform: 'groq', enabled: true, status: 'healthy', maskedKey: secret },
      { id: 2, platform: 'groq', enabled: false, status: 'invalid', maskedKey: secret },
      { id: 3, platform: 'cerebras', enabled: true, status: 'unknown', maskedKey: secret },
    ]);
    if (path === '/api/models') return Response.json([
      { id: 1, platform: 'groq', modelId: 'a', enabled: true },
      { id: 2, platform: 'groq', modelId: 'b', enabled: true },
      { id: 3, platform: 'groq', modelId: 'c', enabled: false },
    ]);
    if (path === '/api/media') return Response.json({ models: [{ id: 1, enabled: true }, { id: 2, enabled: false }] });
    if (path === '/api/embeddings') return Response.json({
      families: [{ providers: [{ id: 1, enabled: true }, { id: 2, enabled: true }] }, { providers: [{ id: 3, enabled: false }] }],
    });
    if (path === '/api/search/engines') return Response.json([{ id: 1, enabled: true }]);
    if (path === '/api/decisions/models') return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('status command', () => {
  it('prints version, keys per platform and enabled models per kind', async () => {
    expect(await main(['status', '--url', 'http://localhost:3100/v1/'])).toBe(0);
    expect(output).toContain('Status   ok  (version 1.2.3)');
    expect(output).toMatch(/cerebras\s+1\s+1\s+0\n/);
    expect(output).toMatch(/groq\s+2\s+1\s+1\n/);
    expect(output).toMatch(/chat\s+2\s+3\n/);
    expect(output).toMatch(/media\s+1\s+2\n/);
    expect(output).toMatch(/embedding\s+2\s+3\n/);
    expect(output).toMatch(/search\s+1\s+1\n/);
    expect(output).toMatch(/decision\s+0\s+0\n/);
    expect(calls[0].path).toBe('/livez');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBeNull();
    for (const call of calls.slice(1)) expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).origin).toBe('http://localhost:3100');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it('emits machine-readable JSON without credentials', async () => {
    expect(await main(['status', '--json'])).toBe(0);
    const report = JSON.parse(output);
    expect(report).toMatchObject({
      reachable: true,
      status: 'ok',
      version: '1.2.3',
      keys: [{ platform: 'cerebras', total: 1, enabled: 1, healthy: 0 }, { platform: 'groq', total: 2, enabled: 1, healthy: 1 }],
      models: {
        chat: { enabled: 2, total: 3 }, media: { enabled: 1, total: 2 }, embedding: { enabled: 2, total: 3 },
        search: { enabled: 1, total: 1 }, decision: { enabled: 0, total: 0 },
      },
    });
    expect(output).not.toContain(secret);
  });

  it('reports reachability and version without a token and skips authenticated routes', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    expect(await main(['status'])).toBe(0);
    expect(output).toContain('version 1.2.3');
    expect(output).toContain('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls.map(c => c.path)).toEqual(['/livez']);
  });

  it('exits 1 when the gateway is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(token));
    expect(await main(['status'])).toBe(1);
    expect(output).toContain('unreachable');
    expect(output).not.toContain(token);
  });

  it('exits 1 and skips authenticated routes when the gateway reports unavailable', async () => {
    livez = { status: 503, body: { status: 'unavailable', version: '1.2.3' } };
    expect(await main(['status', '--json'])).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ reachable: true, status: 'unavailable', keys: null, models: null });
    expect(calls.map(c => c.path)).toEqual(['/livez']);
  });

  it('fails on a rejected token without echoing the response body', async () => {
    vi.mocked(fetch).mockImplementation(async input => new URL(String(input)).pathname === '/livez'
      ? Response.json(livez.body)
      : Response.json({ error: secret }, { status: 401 }));
    await expect(main(['status'])).rejects.toThrow('Dashboard authentication failed');
    expect(output).toBe('');
  });

  it.each([
    ['status', 'extra'],
    ['status', '--dry-run'],
    ['status', '--range', '7d'],
    ['status', '--api-key', secret],
    ['status', '--key', secret],
  ])('rejects invalid or inapplicable arguments before making requests: %j', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('keeps --json out of other commands and parses the report flags', async () => {
    expect(parseArgs(['requests', '--json', '--status=error', '--limit', '5']).options)
      .toMatchObject({ json: true, requestStatus: 'error', limit: '5' });
    await expect(main(['list', '--json'])).rejects.toThrow('--json is only supported by models, status');
    await expect(main(['keys', 'list', '--json'])).rejects.toThrow('--json is only supported by models, status');
    expect(calls).toEqual([]);
  });

  it('shows status help without credentials or requests', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    expect(await main(['status', '--help'])).toBe(0);
    expect(output).toContain('freellmapi status');
    expect(await main(['--help'])).toBe(0);
    expect(output).toContain('requests          Recent request log');
    expect(calls).toEqual([]);
  });
});
