import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const key = { id: 7, platform: 'groq', enabled: true, status: 'healthy', maskedKey: secret, lastHealthError: null as string | null };
const calls: Array<{ path: string; init: RequestInit }> = [];
let keys: Array<typeof key & { modelScope?: string[]; models?: Array<{ id: number; kind: string }> }>;
let output: string;

beforeEach(() => {
  keys = [{ ...key }];
  output = '';
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, init });
    if (path === '/api/keys/providers') return Response.json({ providers: [{ platform: 'groq' }, { platform: 'kilo', keyless: true }] });
    if (path === '/api/keys' && init.method === 'POST') return Response.json({ id: 7, platform: 'groq', maskedKey: secret }, { status: 201 });
    if (path === '/api/keys') return Response.json(keys);
    if (path === '/api/models') return Response.json([
      { id: 1, platform: 'groq', modelId: 'model-a', enabled: true },
      { id: 2, platform: 'groq', modelId: 'model-b', enabled: true },
      { id: 3, platform: 'groq', modelId: 'disabled', enabled: false },
      { id: 4, platform: 'other', modelId: 'other', enabled: true },
    ]);
    if (path.startsWith('/api/health/check/')) return Response.json({ keyId: Number(path.split('/').at(-1)), status: 'healthy' });
    if (path.startsWith('/api/keys/') && init.method === 'DELETE') return Response.json({ success: true });
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('provider key commands', () => {
  it('preserves equals signs in credentials and lets --token override the environment', async () => {
    expect(parseArgs(['keys', 'add', 'groq', `--token=${token}`, `--key=${secret}`]).options)
      .toMatchObject({ token, key: secret });
    await main(['--url', 'http://localhost:3100/v1/', 'keys', 'add', 'groq', '--token', 'override', `--key=${secret}`]);
    expect(calls.map(c => c.path)).toEqual(['/api/keys/providers', '/api/keys', '/api/health/check/7', '/api/keys']);
    expect(calls[1].init.body).toBe(JSON.stringify({ platform: 'groq', key: secret }));
    for (const call of calls) expect(new Headers(call.init.headers).get('Authorization')).toBe('Bearer override');
    expect(output).toContain('Saved groq key 7');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it('lists metadata and enabled chat model counts, without printing even masked keys', async () => {
    keys.push({ ...key, id: 8, enabled: false, modelScope: ['model-b'] });
    expect(await main(['keys', 'list'])).toBe(0);
    expect(output).toContain('7\tgroq\t2\tenabled\thealthy');
    expect(output).toContain('8\tgroq\t1\tdisabled\thealthy');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it('requires an id to remove one of several keys and verifies its platform', async () => {
    keys.push({ ...key, id: 8 });
    await expect(main(['keys', 'remove', 'groq'])).rejects.toThrow('--id');
    await expect(main(['keys', 'remove', 'other', '--id', '7'])).rejects.toThrow('No matching key');
    expect(calls.every(c => c.init.method !== 'DELETE')).toBe(true);
    expect(await main(['keys', 'remove', 'groq', '--id', '8'])).toBe(0);
    expect(calls.at(-1)).toMatchObject({ path: '/api/keys/8', init: { method: 'DELETE' } });
  });

  it('removes a single matching key without touching other providers', async () => {
    keys.push({ ...key, id: 8, platform: 'other' });
    await main(['keys', 'remove', 'groq']);
    expect(calls.filter(c => c.init.method === 'DELETE').map(c => c.path)).toEqual(['/api/keys/7']);
  });

  it('does not equate HTTP 200 with successful validation', async () => {
    keys[0].status = 'invalid';
    expect(await main(['keys', 'test', 'groq'])).toBe(1);
    expect(output).toContain('invalid');
  });

  it('reports inconclusive validation when the server preserves a previously healthy status', async () => {
    keys[0] = { ...key, lastHealthError: secret };
    expect(await main(['keys', 'test', 'groq'])).toBe(1);
    expect(output).toContain('inconclusive');
    expect(output).not.toContain(secret);
  });

  it('checks every matching key and combines unsuccessful results', async () => {
    keys.push({ ...key, id: 8, status: 'invalid' }, { ...key, id: 9, platform: 'other' });
    expect(await main(['keys', 'test', 'groq'])).toBe(1);
    expect(calls.filter(c => c.path.startsWith('/api/health')).map(c => c.path))
      .toEqual(['/api/health/check/7', '/api/health/check/8']);
  });

  it('keeps a newly saved key when validation fails and returns a failure exit code', async () => {
    keys[0].status = 'invalid';
    expect(await main(['keys', 'add', 'groq', '--key', secret])).toBe(1);
    expect(output).toContain('Saved groq key 7');
    expect(calls.every(c => c.init.method !== 'DELETE')).toBe(true);
  });

  it('does not prompt for a keyless provider', async () => {
    keys[0].platform = 'kilo';
    expect(await main(['keys', 'add', 'kilo'])).toBe(0);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ platform: 'kilo', key: '' });
  });

  it('rejects a missing provider key in a non-interactive terminal without adding one', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    try {
      await expect(main(['keys', 'add', 'groq'])).rejects.toThrow('Pass --key');
      expect(calls.some(c => c.init.method === 'POST')).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('does not treat a failed health probe as success when the stored status is healthy', async () => {
    const request = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/api/health/check/')
      ? Promise.resolve(Response.json({ keyId: 7, status: 'error' }))
      : request(input, init));
    expect(await main(['keys', 'test', 'groq'])).toBe(1);
    expect(output).toContain('7\tgroq\terror');
  });

  it('rejects malformed key IDs from the gateway before attempting deletion', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json([{ ...key, id: '../providers' }]));
    await expect(main(['keys', 'remove', 'groq'])).rejects.toThrow('invalid key list');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('counts only enabled chat models on the same custom endpoint', async () => {
    keys = [{ ...key, platform: 'custom', models: [{ id: 1, kind: 'chat' }, { id: 4, kind: 'embedding' }] }];
    vi.mocked(fetch).mockImplementation(async (input) => new URL(String(input)).pathname === '/api/keys'
      ? Response.json(keys)
      : Response.json([
        { id: 1, platform: 'custom', modelId: 'first', enabled: true, keyId: 8 },
        { id: 2, platform: 'custom', modelId: 'other-endpoint', enabled: true, keyId: 9 },
        { id: 4, platform: 'custom', modelId: 'id-shared-with-embedding', enabled: true, keyId: 9 },
      ]));
    await main(['keys', 'list']);
    expect(output).toContain('7\tcustom\t1\tenabled\thealthy');
  });

  it('does not write when the provider identifier is unknown', async () => {
    await expect(main(['keys', 'add', 'missing', '--key', secret])).rejects.toThrow('Unknown provider');
    expect(calls.some(c => c.init.method === 'POST')).toBe(false);
  });

  it('requires a dashboard token rather than using the unified API key', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    vi.stubEnv('FREELLMAPI_API_KEY', 'unified-secret');
    await expect(main(['keys', 'list'])).rejects.toThrow('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls).toEqual([]);
  });

  it.each([
    ['keys', 'remove', 'groq', '--id', '7abc'],
    ['keys', 'remove', 'groq', '--id', '0'],
    ['keys', 'list', 'extra'],
    ['keys', 'remove'],
    ['keys', 'remove', 'groq', '--dry-run'],
    ['keys', 'list', '--key', secret],
    ['keys', 'add', 'groq', '--api-key', secret],
    ['keys', 'remove', 'groq', '--model', 'model-a'],
    ['keys', 'remove', 'groq', '--profile', 'work'],
    ['setup-claude', '--token', token],
    ['setup-claude', '--key', secret],
    ['list', '--id', '7'],
  ])('rejects invalid or inapplicable arguments before making requests: %j', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('does not print server error bodies containing credentials', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: `${secret} ${token}` } }, { status: 401 }));
    await expect(main(['keys', 'list'])).rejects.toThrow('Dashboard authentication failed');
    expect(output).toBe('');
  });

  it('omits secrets from non-authentication failures and transport errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: secret }, { status: 500 }));
    await expect(main(['keys', 'list'])).rejects.toThrow(/^Dashboard request failed \(HTTP 500\)$/);
    vi.mocked(fetch).mockRejectedValueOnce(new Error(token));
    await expect(main(['keys', 'list'])).rejects.toThrow(/^Could not complete the dashboard request\./);
    expect(output).toBe('');
  });

  it('does not send dashboard credentials to redirects and applies the timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await main(['keys', 'test', 'groq', '--id', '7', '--timeout', '5000']);
    expect(calls[0].init).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(timeout).toHaveBeenCalledWith(5000);
    await expect(main(['keys', 'list', '--url', 'http://user:password@localhost:3000'])).rejects.toThrow('without credentials');
  });

  it('shows key-specific help without requiring credentials or making requests', async () => {
    vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', '');
    expect(await main(['keys', '--help'])).toBe(0);
    expect(output).toContain('keys add <platform>');
    expect(output).toContain('FREELLMAPI_DASHBOARD_TOKEN');
    expect(calls).toEqual([]);
  });
});
