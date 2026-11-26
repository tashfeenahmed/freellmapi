import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './index.js';
import { sampleRows } from './test-sample.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; method: string }> = [];
let output: string;
let replies: Record<number, () => Response>;

const models = [
  ...[1, 2, 3, 4, 5, 6].map(id => ({ id, platform: 'groq', modelId: `g${id}`, displayName: `G${id}`, enabled: true, maskedKey: secret })),
  ...[7, 8, 9].map(id => ({ id, platform: 'cerebras', modelId: `c${id}`, displayName: `C${id}`, enabled: true })),
  { id: 10, platform: 'groq', modelId: 'off', displayName: 'Off', enabled: false },
];

beforeEach(() => {
  output = '';
  replies = {};
  calls.length = 0;
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    calls.push({ path, method: init.method ?? 'GET' });
    if (path === '/api/models') return Response.json(models);
    const id = Number(/^\/api\/models\/(\d+)\/test$/.exec(path)?.[1]);
    if (replies[id]) return replies[id]();
    return Response.json({ success: true, modelId: `m${id}`, latencyMs: 120 + id });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const tested = (): number[] => calls.filter(c => c.method === 'POST').map(c => Number(c.path.split('/')[3]));

describe('sampleRows', () => {
  const rows = models.filter(m => m.enabled).map(m => ({ ...m }));

  it('is deterministic per seed, capped per platform, and enabled-only', () => {
    const a = sampleRows(rows, 2, 42).map(r => r.id);
    expect(sampleRows(rows, 2, 42).map(r => r.id)).toEqual(a);
    expect(a).toHaveLength(4);
    expect(a.filter(id => id <= 6)).toHaveLength(2);
    expect(a.filter(id => id >= 7)).toHaveLength(2);
    const other = new Set(Array.from({ length: 20 }, (_, seed) => sampleRows(rows, 2, seed).map(r => r.id).join()));
    expect(other.size).toBeGreaterThan(1);
  });

  it('returns everything when n exceeds the platform size', () => {
    expect(sampleRows(rows, 50, 1)).toHaveLength(9);
  });
});

describe('test-sample', () => {
  it('parses the sample flags', () => {
    expect(parseArgs(['test-sample', '--all', '-n', '3', '--pace=0', '--seed', '9', '--platform', 'groq']).options)
      .toMatchObject({ all: true, count: '3', pace: '0', seed: '9', platform: 'groq' });
  });

  it('tests a seeded sample, one call at a time, and reports a table', async () => {
    expect(await main(['test-sample', '--all', '-n', '1', '--pace', '0', '--seed', '7'])).toBe(0);
    expect(tested()).toHaveLength(2);
    expect(tested().every(id => id !== 10)).toBe(true);
    expect(output).toContain('seed 7');
    expect(output).toMatch(/cerebras\/c\d\s+ok\s+\d+ ms/);
    expect(output).toContain('2 ok, 0 failed.');
    const first = tested();
    calls.length = 0;
    await main(['test-sample', '--all', '-n', '1', '--pace', '0', '--seed', '7']);
    expect(tested()).toEqual(first);
  });

  it('limits to the requested platforms', async () => {
    await main(['test-sample', '--platform', 'GROQ', '-n', '3', '--pace', '0', '--seed', '1']);
    expect(tested()).toHaveLength(3);
    expect(tested().every(id => id <= 6)).toBe(true);
  });

  it('exits 1 and shows a one-line truncated error when a test fails', async () => {
    replies = new Proxy({}, { get: () => () => Response.json({ success: false, latencyMs: 5, error: `bad\n${'x'.repeat(300)} ${secret}` }) });
    expect(await main(['test-sample', '--platform', 'cerebras', '-n', '1', '--pace', '0', '--seed', '1'])).toBe(1);
    expect(output).toContain('FAIL');
    expect(output).toContain('1 failed');
    const row = output.split('\n').find(l => l.includes('FAIL'))!;
    expect(row.length).toBeLessThan(160);
    expect(output).not.toContain(secret);
  });

  it('records an HTTP failure per row and keeps going', async () => {
    replies = new Proxy({}, { get: () => () => new Response('{"error":"x"}', { status: 500 }) });
    expect(await main(['test-sample', '--platform', 'groq,cerebras', '-n', '1', '--pace', '0', '--seed', '1'])).toBe(1);
    expect(tested()).toHaveLength(2);
    expect(output).toContain('Dashboard request failed (HTTP 500)');
  });

  it('retries once after the server throttle window', async () => {
    vi.useFakeTimers();
    let hits = 0;
    replies = new Proxy({}, {
      get: () => () => (hits++ === 0 ? new Response('{}', { status: 429 }) : Response.json({ success: true, latencyMs: 9 })),
    });
    const run = main(['test-sample', '--platform', 'cerebras', '-n', '1', '--pace', '0', '--seed', '1']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await run).toBe(0);
    expect(tested()).toHaveLength(2);
  });

  it('--dry-run lists the sample and sends no test', async () => {
    expect(await main(['test-sample', '--all', '-n', '1', '--seed', '3', '--dry-run'])).toBe(0);
    expect(tested()).toHaveLength(0);
    expect(output).toContain('skipped');
  });

  it('prints a message when nothing matches', async () => {
    expect(await main(['test-sample', '--platform', 'nvidia', '--pace', '0'])).toBe(0);
    expect(output).toContain('No enabled chat models match.');
    expect(tested()).toHaveLength(0);
  });

  it.each([
    [['test-sample'], '--platform a,b or --all'],
    [['test-sample', '--all', '--platform', 'groq'], 'cannot be combined'],
    [['test-sample', '--all', '-n', '0'], '-n must be'],
    [['test-sample', '--all', '-n', '1.5'], '-n must be'],
    [['test-sample', '--all', '--pace', '-1'], 'requires a value'],
    [['test-sample', '--all', '--pace', 'x'], '--pace must be'],
    [['test-sample', '--all', '--seed', 'x'], '--seed must be'],
    [['test-sample', '--platform', 'a b'], 'Invalid --platform'],
    [['test-sample', '--all', 'extra'], 'Unknown option'],
    [['test-sample', '--all', '--json'], '--json is only supported'],
    [['status', '--seed', '1'], 'only supported by test-sample'],
    [['models', 'list', '-n', '1'], 'only supported by test-sample'],
  ])('%j makes no request', async (argv, message) => {
    await expect(main(argv)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('never prints the token or key material', async () => {
    await main(['test-sample', '--all', '--pace', '0', '--seed', '1']);
    expect(output).not.toContain(token);
    expect(output).not.toContain(secret);
  });
});
