import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './index.js';

const token = 'dashboard-session==';
const calls: Array<{ path: string; init: RequestInit }> = [];
let output: string;
let failPath: string | undefined;

function last(): { path: string; method?: string; body: unknown } {
  const call = calls.at(-1)!;
  return { path: call.path, method: call.init.method, body: JSON.parse(String(call.init.body)) };
}

beforeEach(() => {
  output = '';
  failPath = undefined;
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, init });
    if (path === failPath) return new Response('boom', { status: 500 });
    if (init.method === 'PUT') return Response.json({ stored: JSON.parse(String(init.body)) });
    return Response.json({ path });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('settings get', () => {
  it('prints one setting', async () => {
    expect(await main(['settings', 'get', 'compression'])).toBe(0);
    expect(calls.map(c => c.path)).toEqual(['/api/settings/compression']);
    expect(JSON.parse(output)).toEqual({ path: '/api/settings/compression' });
  });

  it('prints every allowlisted setting and never touches secret routes', async () => {
    expect(await main(['settings', 'get'])).toBe(0);
    const paths = calls.map(c => c.path);
    expect(paths).toContain('/api/settings/guardrails');
    expect(paths).toHaveLength(Object.keys(JSON.parse(output)).length);
    for (const secret of ['api-key', 'url-tokens', 'proxy']) {
      expect(paths).not.toContain(`/api/settings/${secret}`);
    }
    expect(calls.every(c => (c.init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reports a failing route in place and exits 1', async () => {
    failPath = '/api/settings/headroom';
    expect(await main(['settings', 'get'])).toBe(1);
    expect(JSON.parse(output).headroom).toEqual({ error: 'Dashboard request failed (HTTP 500)' });
    expect(JSON.parse(output).fusion).toEqual({ path: '/api/settings/fusion' });
  });

  it('rejects secret and unknown names without a request', async () => {
    for (const name of ['api-key', 'url-tokens', 'proxy', 'constructor', 'nope']) {
      await expect(main(['settings', 'get', name])).rejects.toThrow('Unknown setting');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('settings set', () => {
  it('parses positional JSON', () => {
    expect(parseArgs(['settings', 'set', 'enable-mcp', '{"enabled":true}']).options.args)
      .toEqual(['set', 'enable-mcp', '{"enabled":true}']);
  });

  it.each([
    ['update-check', { enabled: false }],
    ['system-date', { mode: 'web_search' }],
    ['compression', { mode: 'off' }],
    ['unify', { enabled: true }],
    ['fusion', { k: 3 }],
    ['enable-mcp', { enabled: true }],
    ['anthropic-map', { opus: 'auto' }],
    ['gemini-map', { pro: 'tier:pro' }],
    ['agent-compatibility', { ollamaEmulation: 'off' }],
    ['output-limit', { mode: 8192 }],
    ['output-limit', { mode: 'auto' }],
    ['min-context-window', { value: '128K' }],
    ['guardrails', { maxConsecutiveUpstreamFails: 3 }],
    ['headroom', { rampStart: 0.2, floor: null }],
    ['task-weight-share', { share: null }],
    ['min-reliability-floor', { floor: 0.8 }],
    ['provider-moment-attribution', { enabled: true }],
  ])('sends the %s body as given', async (name, body) => {
    expect(await main(['settings', 'set', name, JSON.stringify(body)])).toBe(0);
    expect(last()).toEqual({ path: `/api/settings/${name}`, method: 'PUT', body });
    expect(JSON.parse(output)).toEqual({ stored: body });
  });

  it.each([
    ['not json', '{', 'not valid JSON'],
    ['array body', '[1]', 'takes a JSON object'],
    ['unknown field', '{"enabled":true,"extra":1}', 'no field "extra"'],
    ['wrong type', '{"enabled":"yes"}', 'Invalid enable-mcp.enabled'],
    ['missing required', '{}', 'needs "enabled"'],
  ])('%s makes no request', async (_label, body, message) => {
    await expect(main(['settings', 'set', 'enable-mcp', body])).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['output-limit', '{"mode":0}'],
    ['output-limit', '{"mode":"8192"}'],
    ['system-date', '{"mode":"sometimes"}'],
    ['min-context-window', '{"value":"64k"}'],
    ['headroom', '{"floor":1.5}'],
    ['task-weight-share', '{}'],
    ['guardrails', '{"requestMaxTokensBudget":-1}'],
    ['agent-compatibility', '{"ollamaEmulation":"on"}'],
    ['anthropic-map', '{"opus":1}'],
    ['api-key', '{}'],
    ['proxy', '{"url":"http://u:p@h"}'],
  ])('rejects %s %s locally', async (name, body) => {
    await expect(main(['settings', 'set', name, body])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('needs a name and exactly one value', async () => {
    await expect(main(['settings', 'set', 'enable-mcp'])).rejects.toThrow('name and one JSON value');
    await expect(main(['settings', 'set', 'enable-mcp', '{}', 'x'])).rejects.toThrow('name and one JSON value');
    await expect(main(['settings', 'bogus'])).rejects.toThrow('settings get or set');
    expect(calls).toHaveLength(0);
  });

  it('--dry-run validates and sends nothing', async () => {
    expect(await main(['settings', 'set', 'update-check', '{"enabled":false}', '--dry-run'])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(output).toContain('Would PUT /api/settings/update-check');
    await expect(main(['settings', 'get', '--dry-run'])).rejects.toThrow('--dry-run');
  });

  it('never prints the token', async () => {
    await main(['settings', 'get']);
    await main(['settings', 'set', 'enable-mcp', '{"enabled":true}']);
    expect(output).not.toContain(token);
    expect(calls.every(c => (c.init.headers as Record<string, string>).Authorization === `Bearer ${token}`)).toBe(true);
  });

  it('requires the dashboard token', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    await expect(main(['settings', 'get'])).rejects.toThrow('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls).toHaveLength(0);
  });
});
