import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import dns from 'node:dns';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Moonshot's assistant `partial: true` prefill flag (#1038) must survive the
// whole proxy path — request schema → message build → provider body — when the
// route lands on Moonshot's own API (a custom endpoint on a Moonshot host), and
// must be stripped for any other endpoint, even one serving a Kimi model.

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(data); } catch {}
  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

/** Stub the upstream chat call and capture what reached it. */
function stubUpstream(modelId: string): { url: () => string; body: () => any } {
  const origFetch = global.fetch;
  let url = '';
  let body: any = null;
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const u = typeof input === 'string' ? input : input.toString();
    // Only the two registered upstreams; the app under test also lives on
    // 127.0.0.1 (random port) and must keep going through the real fetch.
    if (u.startsWith('https://api.moonshot.ai/') || u.startsWith('http://127.0.0.1:11434/')) {
      url = u;
      body = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-partial',
          object: 'chat.completion',
          created: 123,
          model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: ' 42.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      } as any;
    }
    return origFetch(input, init);
  });
  return { url: () => url, body: () => body };
}

const conversation = [
  { role: 'user', content: 'What is six times seven? Answer with the number only.' },
  { role: 'assistant', content: 'The answer is', partial: true },
];

describe('Moonshot `partial` prefill round trip (#1038)', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();

    // The custom-platform SSRF guard resolves public hosts at save time and on
    // every request; answer with a public address so no real DNS is needed.
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);

    const moonshot = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2-0905-preview',
      apiKey: 'sk-moonshot-test',
      label: 'Moonshot',
    });
    expect(moonshot.status).toBe(201);

    const ollama = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'kimi-k2:1t-cloud',
      label: 'Ollama box',
    });
    expect(ollama.status).toBe(201);
  });

  beforeEach(() => {
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '203.0.113.10', family: 4 }] as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a trailing assistant partial:true to a Moonshot custom endpoint', async () => {
    const upstream = stubUpstream('kimi-k2-0905-preview');
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'kimi-k2-0905-preview',
      messages: conversation,
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe(' 42.');
    expect(upstream.url()).toBe('https://api.moonshot.ai/v1/chat/completions');
    const sent = upstream.body().messages;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ role: 'assistant', content: 'The answer is', partial: true });
    expect(sent[0]).not.toHaveProperty('partial');
  });

  it('strips partial for a custom endpoint on any other host, even for a Kimi model', async () => {
    const upstream = stubUpstream('kimi-k2:1t-cloud');
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'kimi-k2:1t-cloud',
      messages: conversation,
    }, authHeaders());

    expect(status).toBe(200);
    expect(upstream.url()).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const sent = upstream.body().messages;
    expect(sent[1]).toMatchObject({ role: 'assistant', content: 'The answer is' });
    expect(sent[1]).not.toHaveProperty('partial');
  });

  it('rejects a non-boolean partial at the request schema', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'kimi-k2-0905-preview',
      messages: [conversation[0], { role: 'assistant', content: 'The answer is', partial: 'yes' }],
    }, authHeaders());
    expect(status).toBe(400);
  });
});
