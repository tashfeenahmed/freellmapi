import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; search: URLSearchParams; init: RequestInit }> = [];
let output: string;

const summary = {
  totalRequests: 1234, successRate: 91.5, totalInputTokens: 5000, totalOutputTokens: 2500,
  avgLatencyMs: 420, p50LatencyMs: 300, p95LatencyMs: 1500,
};
const providers = [
  { platform: 'groq', providerId: 'groq', endpoint: 'groq', requests: 1000, successRate: 95, errorCount: 50, avgLatencyMs: 300, totalInputTokens: 4000, totalOutputTokens: 2000 },
  { platform: 'custom', providerId: 'custom:https://relay.example', endpoint: 'relay.example', requests: 200, successRate: 60, errorCount: 80, avgLatencyMs: 900, totalInputTokens: 900, totalOutputTokens: 400 },
  { platform: 'cerebras', providerId: 'cerebras', endpoint: 'cerebras', requests: 34, successRate: 100, errorCount: 0, avgLatencyMs: 120, totalInputTokens: 100, totalOutputTokens: 100 },
];
const rows = [
  { id: 2, platform: 'groq', modelId: 'llama', requestType: 'chat', status: 'error', inputTokens: 10, outputTokens: 0, latencyMs: 812, error: `429 rate\nlimited ${'x'.repeat(200)}`, createdAt: '2026-11-25T01:02:03Z', keyLabel: null },
  { id: 1, platform: 'groq', modelId: 'llama', requestType: 'chat', status: 'success', inputTokens: 1200, outputTokens: 300, latencyMs: 250, error: null, createdAt: '2026-11-25T01:00:00Z', keyLabel: null },
];

beforeEach(() => {
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, search: url.searchParams, init });
    if (url.pathname === '/api/analytics/summary') return Response.json(summary);
    if (url.pathname === '/api/analytics/by-platform') return Response.json(providers);
    if (url.pathname === '/api/analytics/requests') return Response.json({ total: 57, rows });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('usage command', () => {
  it('prints totals and a per-provider table for the default range', async () => {
    expect(await main(['usage'])).toBe(0);
    expect(calls.map(c => `${c.path}?${c.search}`)).toEqual([
      '/api/analytics/summary?range=7d', '/api/analytics/by-platform?range=7d',
    ]);
    for (const call of calls) expect(new Headers(call.init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(output).toContain('Usage, range 7d');
    expect(output).toContain('Requests  1,234  (success 91.5%)');
    expect(output).toContain('Tokens    5,000 in, 2,500 out');
    expect(output).toContain('p95 1500 ms');
    expect(output).toMatch(/relay\.example\s+200\s+60%\s+80\s+900 ms\s+900\s+400\n/);
    expect(output).not.toContain(token);
  });

  it('passes --range through and limits providers with --top', async () => {
    await main(['usage', '--range', '30d', '--top', '2']);
    expect(calls[0].search.get('range')).toBe('30d');
    expect(output).toContain('groq');
    expect(output).not.toContain('cerebras');
    expect(output).toContain('... and 1 more (raise --top)');
  });

  it('emits JSON with the same truncation', async () => {
    expect(await main(['usage', '--range', 'all', '--top', '1', '--json'])).toBe(0);
    const report = JSON.parse(output);
    expect(report.range).toBe('all');
    expect(report.summary.totalRequests).toBe(1234);
    expect(report.providers).toHaveLength(1);
    expect(report.providerCount).toBe(3);
  });

  it('reports an empty range', async () => {
    vi.mocked(fetch).mockImplementation(async input => new URL(String(input)).pathname.endsWith('summary')
      ? Response.json({ ...summary, totalRequests: 0, p95LatencyMs: null })
      : Response.json([]));
    await main(['usage', '--range', '24h']);
    expect(output).toContain('No requests in this range.');
    expect(output).toContain('p95 -');
  });

  it.each([
    ['usage', '--range', '90d'],
    ['usage', '--top', '0'],
    ['usage', '--top', '3x'],
    ['usage', '--limit', '5'],
    ['usage', '--status', 'error'],
    ['usage', 'extra'],
    ['usage', '--dry-run'],
    ['usage', '--model', 'x'],
  ])('rejects invalid or inapplicable arguments before making requests: %j', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('requires a dashboard token', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    await expect(main(['usage'])).rejects.toThrow('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls).toEqual([]);
  });

  it('rejects a malformed analytics response', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({}));
    await expect(main(['usage'])).rejects.toThrow('invalid analytics response');
  });
});

describe('requests command', () => {
  it('queries the log with defaults and prints one line per request', async () => {
    expect(await main(['requests'])).toBe(0);
    expect(calls[0].path).toBe('/api/analytics/requests');
    expect(Object.fromEntries(calls[0].search)).toEqual({ range: '24h', limit: '20' });
    expect(output).toMatch(/2026-11-25T01:00:00Z\s+success\s+chat\s+groq\/llama\s+250 ms\s+1,200\/300/);
    expect(output).toContain('Showing 2 of 57 in range 24h');
  });

  it('keeps each error on one truncated line', async () => {
    await main(['requests']);
    const line = output.split('\n').find(l => l.includes('429 rate limited'))!;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('...');
  });

  it('passes --range, --status and --limit to the route', async () => {
    await main(['requests', '--range', '7d', '--status', 'canceled', '--limit', '500']);
    expect(Object.fromEntries(calls[0].search)).toEqual({ range: '7d', limit: '500', status: 'canceled' });
  });

  it('emits JSON rows as returned by the gateway', async () => {
    expect(await main(['requests', '--json'])).toBe(0);
    expect(JSON.parse(output)).toEqual({ range: '24h', total: 57, rows });
  });

  it('reports an empty log', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ total: 0, rows: [] }));
    await main(['requests', '--status', 'error']);
    expect(output).toContain('No matching requests.');
    expect(output).toContain('Showing 0 of 0');
  });

  it.each([
    ['requests', '--status', 'failed'],
    ['requests', '--limit', '501'],
    ['requests', '--limit', '0'],
    ['requests', '--range', '1h'],
    ['requests', '--top', '3'],
    ['requests', 'extra'],
  ])('rejects invalid or inapplicable arguments before making requests: %j', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('does not print server error bodies containing credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: `${secret} ${token}` }, { status: 500 }));
    await expect(main(['requests'])).rejects.toThrow(/^Dashboard request failed \(HTTP 500\)$/);
    expect(output).toBe('');
  });

  it('shows help for usage and requests without credentials', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    await main(['usage', '--help']);
    await main(['requests', '--help']);
    expect(output).toContain('freellmapi usage [--range');
    expect(output).toContain('freellmapi requests [--range');
    expect(calls).toEqual([]);
  });
});
