import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; init: RequestInit }> = [];
let output: string;

function last(): { path: string; method?: string; body: unknown } {
  const call = calls.at(-1)!;
  return { path: call.path, method: call.init.method, body: JSON.parse(String(call.init.body)) };
}

beforeEach(() => {
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, init });
    if ((init.method ?? 'GET') !== 'GET') return Response.json({ success: true, updatedKeys: 2 });
    if (path === '/api/models') return Response.json([
      { id: 1, platform: 'groq', modelId: 'llama', displayName: 'Llama', enabled: true, maskedKey: secret },
      { id: 2, platform: 'groq', modelId: 'gemma', displayName: 'Gemma', enabled: false },
      { id: 3, platform: 'cerebras', modelId: 'qwen', displayName: 'Qwen', enabled: false },
    ]);
    if (path === '/api/media') return Response.json({ models: [{ id: 5, platform: 'cloudflare', modelId: 'flux', displayName: 'Flux', enabled: false }] });
    if (path === '/api/embeddings') return Response.json({ families: [{ family: 'bge', providers: [
      { id: 8, platform: 'cloudflare', modelId: 'bge-m3', displayName: 'BGE', priority: 3, enabled: true },
      { id: 9, platform: 'google', modelId: 'gemini-embed', displayName: 'G', priority: 4, enabled: false },
    ] }] });
    if (path === '/api/search/engines') return Response.json([{ id: 4, platform: 'tavily', engineId: 'tavily-search', displayName: 'Tavily', enabled: false }]);
    if (path === '/api/decisions/models') return Response.json([{ id: 6, platform: 'groq', modelId: 'judge', displayName: 'Judge', enabled: false }]);
    if (path === '/api/keys') return Response.json([
      { id: 7, platform: 'groq', enabled: true, status: 'healthy', maskedKey: secret },
      { id: 8, platform: 'groq', enabled: true, status: 'healthy', maskedKey: secret },
    ]);
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('models list', () => {
  it('parses the model flags', () => {
    expect(parseArgs(['models', 'list', '--kind', 'media', '--platform=a,b', '--disabled']).options)
      .toMatchObject({ kind: 'media', platform: 'a,b', enabledFilter: false });
    expect(() => parseArgs(['models', 'list', '--enabled', '--disabled'])).toThrow('cannot be combined');
  });

  it('defaults to chat and filters by platform and state', async () => {
    expect(await main(['models', 'list'])).toBe(0);
    expect(calls.map(c => c.path)).toEqual(['/api/models']);
    expect(output).toMatch(/1\s+groq\s+llama\s+yes/);
    output = '';
    await main(['models', 'list', '--platform', 'groq', '--disabled']);
    expect(output).toContain('gemma');
    expect(output).not.toContain('llama');
    expect(output).not.toContain('qwen');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it.each([
    ['chat', '/api/models', 'llama'],
    ['media', '/api/media', 'flux'],
    ['embedding', '/api/embeddings', 'bge-m3'],
    ['search', '/api/search/engines', 'tavily-search'],
    ['decision', '/api/decisions/models', 'judge'],
  ])('reads %s models from %s', async (kind, path, modelId) => {
    expect(await main(['models', 'list', '--kind', kind, '--json'])).toBe(0);
    expect(calls.map(c => c.path)).toEqual([path]);
    const rows = JSON.parse(output) as Array<{ kind: string; modelId: string }>;
    expect(rows[0]).toMatchObject({ kind, modelId });
    expect(output).not.toContain(secret);
  });

  it('rejects bad input before any request', async () => {
    await expect(main(['models'])).rejects.toThrow('Expected models');
    await expect(main(['models', 'list', '--kind', 'image'])).rejects.toThrow('--kind');
    await expect(main(['models', 'list', 'extra'])).rejects.toThrow('Invalid arguments');
    await expect(main(['models', 'list', '--platform', 'Bad Name'])).rejects.toThrow('--platform');
    await expect(main(['models', 'list', '--dry-run'])).rejects.toThrow('--dry-run');
    await expect(main(['list', '--kind', 'chat'])).rejects.toThrow('only supported by models');
    await expect(main(['keys', 'list', '--enabled'])).rejects.toThrow('only supported by models');
    expect(calls).toEqual([]);
  });
});

describe('models enable and disable', () => {
  it('uses each kind\'s own route and body', async () => {
    await main(['models', 'enable', '2']);
    expect(last()).toEqual({ path: '/api/models/2', method: 'PATCH', body: { enabled: true, fallbackEnabled: true } });
    await main(['models', 'disable', '1']);
    expect(last()).toEqual({ path: '/api/models/1', method: 'PATCH', body: { enabled: false } });
    await main(['models', 'enable', '5', '--kind', 'media']);
    expect(last()).toEqual({ path: '/api/media/5', method: 'PUT', body: { enabled: true } });
    await main(['models', 'enable', '4', '--kind', 'search']);
    expect(last()).toEqual({ path: '/api/search/engines/4', method: 'PATCH', body: { enabled: true } });
    await main(['models', 'disable', '6', '--kind', 'decision']);
    expect(last()).toEqual({ path: '/api/decisions/models/6', method: 'PATCH', body: { enabled: false } });
    expect(output).toContain('Disabled decision model 6 (groq/judge).');
  });

  it('sends embedding rows in one PUT that keeps their priority', async () => {
    await main(['models', 'disable', '8', '9', '9', '--kind', 'embedding']);
    expect(calls.filter(c => c.init.method === 'PUT')).toHaveLength(1);
    expect(last()).toEqual({
      path: '/api/embeddings',
      method: 'PUT',
      body: { providers: [{ id: 8, priority: 3, enabled: false }, { id: 9, priority: 4, enabled: false }] },
    });
  });

  it('rejects unknown IDs without writing and bad IDs without any request', async () => {
    await expect(main(['models', 'enable', '99'])).rejects.toThrow('Unknown chat model ID 99');
    expect(calls.map(c => c.init.method ?? 'GET')).toEqual(['GET']);
    calls.length = 0;
    await expect(main(['models', 'enable'])).rejects.toThrow('positive integer IDs');
    await expect(main(['models', 'enable', 'abc'])).rejects.toThrow('positive integer IDs');
    await expect(main(['models', 'enable', '0'])).rejects.toThrow('positive integer IDs');
    await expect(main(['models', 'enable', '1', '--platform', 'groq'])).rejects.toThrow('only supported by models list');
    await expect(main(['models', 'enable', '1', '--json'])).rejects.toThrow('--json');
    expect(calls).toEqual([]);
  });

  it('requires a dashboard token and never prints it', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    await expect(main(['models', 'list'])).rejects.toThrow('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls).toEqual([]);
    expect(output).not.toContain(token);
  });
});

describe('keys enable and disable', () => {
  it('switches a whole platform through the platform route', async () => {
    expect(await main(['keys', 'disable', 'groq'])).toBe(0);
    expect(last()).toEqual({ path: '/api/keys/platform/groq', method: 'PATCH', body: { enabled: false } });
    expect(output).toContain('Disabled 2 groq key(s).');
    await main(['keys', 'enable', 'groq']);
    expect(last().body).toEqual({ enabled: true });
  });

  it('switches one key with --id after checking its platform', async () => {
    expect(await main(['keys', 'enable', 'groq', '--id', '8'])).toBe(0);
    expect(last()).toEqual({ path: '/api/keys/8', method: 'PATCH', body: { enabled: true } });
    await expect(main(['keys', 'disable', 'groq', '--id', '99'])).rejects.toThrow('No matching key');
    await expect(main(['keys', 'disable', 'other'])).rejects.toThrow('No matching key');
    expect(calls.filter(c => c.init.method === 'PATCH')).toHaveLength(1);
    expect(output).not.toContain(secret);
  });

  it('rejects a missing platform before any request', async () => {
    await expect(main(['keys', 'enable'])).rejects.toThrow('Invalid arguments');
    await expect(main(['keys', 'enable', 'groq', '--key', 'x'])).rejects.toThrow('--key');
    expect(calls).toEqual([]);
  });
});
