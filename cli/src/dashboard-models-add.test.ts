import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const token = 'dashboard-session==';
const secret = 'provider-secret==';
const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let output: string;
let dir: string;
let stored: Array<{ id: number; platform: string; modelId: string; enabled: boolean }>;
let rejectWith: Record<string, number>;
let dropOnReadBack: string | undefined;

function file(content: unknown): string {
  const path = join(dir, 'models.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

const posts = (): unknown[] => calls.filter(c => c.method === 'POST').map(c => c.body);

beforeEach(() => {
  output = '';
  calls.length = 0;
  rejectWith = {};
  dropOnReadBack = undefined;
  dir = mkdtempSync(join(tmpdir(), 'freellmapi-add-'));
  stored = [{ id: 1, platform: 'groq', modelId: 'llama', enabled: true }];
  vi.stubEnv('FREELLMAPI_DASHBOARD_TOKEN', token);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path !== '/api/models') throw new Error(`Unexpected request: ${path}`);
    if (method === 'GET') {
      return Response.json(stored.map(row => ({ ...row, maskedKey: secret })));
    }
    if (rejectWith[body.modelId]) return new Response(`{"error":"${secret}"}`, { status: rejectWith[body.modelId] });
    if (body.modelId !== dropOnReadBack) stored.push({ id: stored.length + 1, platform: body.platform, modelId: body.modelId, enabled: true });
    return Response.json({ success: true, id: stored.length }, { status: 201 });
  }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('models add', () => {
  it('posts each row, then reads back and reports added, present, and failed', async () => {
    rejectWith.bad = 400;
    const rows = [
      { platform: 'groq', modelId: 'new', displayName: 'New', contextWindow: 8192, supportsTools: false, monthlyTokenBudget: '1m' },
      { platform: 'groq', modelId: 'llama' },
      { platform: 'cerebras', modelId: 'bad' },
      { platform: 'custom', modelId: 'dup', keyId: 4 },
    ];
    rejectWith.dup = 409;
    expect(await main(['models', 'add', file(rows)])).toBe(1);
    expect(posts()).toEqual([rows[0], rows[2], rows[3]]);
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/models' });
    expect(output).toMatch(/1\s+groq\s+new\s+added/);
    expect(output).toMatch(/2\s+groq\s+llama\s+present/);
    expect(output).toMatch(/3\s+cerebras\s+bad\s+failed\s+Dashboard request failed \(HTTP 400\)/);
    expect(output).toMatch(/4\s+custom\s+dup\s+present/);
    expect(output).toContain('1 added, 2 already present, 1 failed.');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it('exits 0 when everything is added or present', async () => {
    expect(await main(['models', 'add', file([{ platform: 'groq', modelId: 'a' }, { platform: 'groq', modelId: 'llama' }])])).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  it('flags a row the read-back cannot find', async () => {
    dropOnReadBack = 'ghost';
    expect(await main(['models', 'add', file([{ platform: 'groq', modelId: 'ghost' }])])).toBe(1);
    expect(output).toContain('not found on read-back');
  });

  it('--dry-run reads the list but posts nothing', async () => {
    expect(await main(['models', 'add', file([{ platform: 'groq', modelId: 'a' }, { platform: 'groq', modelId: 'llama' }]), '--dry-run'])).toBe(0);
    expect(calls.map(c => c.method)).toEqual(['GET']);
    expect(output).toMatch(/1\s+groq\s+a\s+would add/);
    expect(output).toMatch(/2\s+groq\s+llama\s+present/);
    expect(output).toContain('Dry run, nothing sent. 1 to add, 1 already present, 0 failed.');
  });

  it.each([
    ['not json', '{', 'not valid JSON'],
    ['not an array', '{"platform":"groq"}', 'non-empty JSON array'],
    ['empty array', '[]', 'non-empty JSON array'],
    ['non-object row', '[1]', 'row 1: not an object'],
    ['missing modelId', '[{"platform":"groq"}]', 'row 1: missing modelId'],
    ['unknown field', '[{"platform":"groq","modelId":"a","enabled":true}]', 'unknown field "enabled"'],
    ['wrong type', '[{"platform":"groq","modelId":"a","contextWindow":"8k"}]', 'invalid contextWindow'],
    ['non-positive limit', '[{"platform":"groq","modelId":"a","rpmLimit":0}]', 'invalid rpmLimit'],
    ['empty id', '[{"platform":"groq","modelId":""}]', 'invalid modelId'],
    ['in-file duplicate', '[{"platform":"groq","modelId":"a"},{"platform":"groq","modelId":"a"}]', 'row 2: duplicate'],
  ])('%s fails before any request, even with a valid first row', async (_label, content, message) => {
    await expect(main(['models', 'add', file(content)])).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('reports every bad row together', async () => {
    await expect(main(['models', 'add', file([{ platform: 'groq' }, { modelId: 'x' }])])).rejects.toThrow(/row 1.*\n.*row 2/);
    expect(calls).toHaveLength(0);
  });

  it('rejects bad invocations without a request', async () => {
    await expect(main(['models', 'add'])).rejects.toThrow('needs a JSON file');
    await expect(main(['models', 'add', join(dir, 'missing.json')])).rejects.toThrow('Could not read');
    const path = file([{ platform: 'groq', modelId: 'a' }]);
    await expect(main(['models', 'add', path, path])).rejects.toThrow('one file');
    await expect(main(['models', 'add', path, '--kind', 'media'])).rejects.toThrow('chat models only');
    await expect(main(['models', 'add', path, '--json'])).rejects.toThrow('chat models only');
    await expect(main(['models', 'enable', '1', '--dry-run'])).rejects.toThrow('--dry-run is only supported by models add');
    expect(calls).toHaveLength(0);
  });
});
