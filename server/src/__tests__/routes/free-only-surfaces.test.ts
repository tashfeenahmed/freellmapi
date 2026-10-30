import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Free-only routing end to end: a credit-based provider (Hugging Face Router)
// has a healthy key, yet no chat surface may send it traffic unless the
// operator opts in. The free provider (Groq) keeps serving. The upstream is
// mocked; the assertion that matters is that the credit-based host is never
// contacted.

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const auth = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });

const completion = {
  id: 'chatcmpl-free-only', object: 'chat.completion', created: 1, model: 'default',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

describe('free-only routing across chat surfaces', () => {
  let app: Express;
  let groqModel: string;
  let hfModel: string;
  const upstreamHosts: string[] = [];
  const savedAllow = process.env.FREE_ONLY_ALLOW_PLATFORMS;
  const savedRouting = process.env.FREE_ONLY_ROUTING;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const pick = (platform: string) => (getDb().prepare(
      'SELECT model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1',
    ).get(platform) as { model_id: string }).model_id;
    groqModel = pick('groq');
    hfModel = pick('huggingface');
  });

  beforeEach(async () => {
    delete process.env.FREE_ONLY_ALLOW_PLATFORMS;
    delete process.env.FREE_ONLY_ROUTING;
    upstreamHosts.length = 0;
    getDb().prepare('DELETE FROM api_keys').run();
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('api.groq.com') || u.includes('router.huggingface.co')) {
        upstreamHosts.push(new URL(u).host);
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => Promise.resolve(completion), text: () => Promise.resolve(JSON.stringify(completion)) } as any;
      }
      return origFetch(url, init);
    });
    for (const [platform, key] of [['groq', 'gsk_free_only_test'], ['huggingface', 'hf_free_only_test']]) {
      const added = await request(app, 'POST', '/api/keys', { platform, key, label: 'free-only' });
      expect(added.status).toBe(201);
    }
    upstreamHosts.length = 0; // key validation probes are not chat traffic
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedAllow === undefined) delete process.env.FREE_ONLY_ALLOW_PLATFORMS; else process.env.FREE_ONLY_ALLOW_PLATFORMS = savedAllow;
    if (savedRouting === undefined) delete process.env.FREE_ONLY_ROUTING; else process.env.FREE_ONLY_ROUTING = savedRouting;
  });

  const chat = (model?: string) => request(app, 'POST', '/v1/chat/completions', {
    ...(model ? { model } : {}), messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
  }, auth());

  it('auto routing is served by the free provider only', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await chat('auto');
      expect(res.status).toBe(200);
    }
    expect(upstreamHosts.length).toBeGreaterThan(0);
    expect(upstreamHosts.every(h => h === 'api.groq.com')).toBe(true);
  });

  it('a named credit-based model is refused on /v1/chat/completions and never contacted', async () => {
    const res = await chat(hfModel);
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('free_only_blocked');
    expect(res.body?.error?.message).toMatch(/free-only routing/i);
    expect(res.body?.error?.message).toContain('FREE_ONLY_ALLOW_PLATFORMS');
    expect(upstreamHosts).not.toContain('router.huggingface.co');
  });

  it('the same model is refused on /v1/messages', async () => {
    const res = await request(app, 'POST', '/v1/messages', {
      model: hfModel, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }],
    }, { ...auth(), 'anthropic-version': '2023-06-01' });
    expect(res.status).not.toBe(200);
    expect(upstreamHosts).not.toContain('router.huggingface.co');
  });

  it('the same model is refused on /v1/responses', async () => {
    const res = await request(app, 'POST', '/v1/responses', { model: hfModel, input: 'hi', max_output_tokens: 16 }, auth());
    expect(res.status).not.toBe(200);
    expect(upstreamHosts).not.toContain('router.huggingface.co');
  });

  it('a named free model is still served', async () => {
    const res = await chat(groqModel);
    expect(res.status).toBe(200);
    expect(upstreamHosts).toEqual(['api.groq.com']);
  });

  it('an operator opt-in lets the credit-based model through', async () => {
    process.env.FREE_ONLY_ALLOW_PLATFORMS = 'huggingface';
    const res = await chat(hfModel);
    expect(res.status).toBe(200);
    expect(upstreamHosts).toEqual(['router.huggingface.co']);
  });

  it('error bodies carry the policy reason but no key material', async () => {
    const res = await chat(hfModel);
    expect(res.text).not.toContain('hf_free_only_test');
    expect(res.text).not.toContain('gsk_free_only_test');
  });
});
