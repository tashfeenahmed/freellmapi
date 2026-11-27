import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { hashClientProfileKey, mintClientProfileKey } from '../../lib/system-prompt.js';
import { setSystemDateMode } from '../../lib/system-date.js';
import { mintDashboardToken } from '../helpers/auth.js';

let server: http.Server;
let baseUrl: string;
let dashToken: string;
let apiKey: string;
let origFetch: typeof fetch;
let capturedBodies: Array<Record<string, any>>;

beforeAll(async () => {
  initDb(':memory:');
  const app = createApp();
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  dashToken = mintDashboardToken();
  apiKey = getUnifiedApiKey();
  origFetch = globalThis.fetch;

  // Register one enabled Groq key so /v1/chat/completions and /v1/messages can route.
  const enc = encrypt('gsk_system_date_test_key_123456');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES ('groq', 'test', ?, ?, ?, 1, 'healthy')
  `).run(enc.encrypted, enc.iv, enc.authTag);
});

afterAll(() => {
  globalThis.fetch = origFetch;
  server?.close();
});

beforeEach(() => {
  setSystemDateMode('off');
  capturedBodies = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return origFetch(input, init);
    capturedBodies.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

async function apiJson(method: string, path: string, body?: unknown, token = dashToken) {
  const res = await origFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe('System date setting & injection routes (#1931)', () => {
  it('reads, updates, and validates /api/settings/system-date', async () => {
    const initial = await apiJson('GET', '/api/settings/system-date');
    expect(initial).toEqual({ status: 200, body: { mode: 'off' } });

    const updated = await apiJson('PUT', '/api/settings/system-date', { mode: 'web_search' });
    expect(updated).toEqual({ status: 200, body: { mode: 'web_search' } });

    const readBack = await apiJson('GET', '/api/settings/system-date');
    expect(readBack).toEqual({ status: 200, body: { mode: 'web_search' } });

    const bad = await apiJson('PUT', '/api/settings/system-date', { mode: 'hourly' });
    expect(bad.status).toBe(400);
  });

  it('respects off, web_search, and always modes on /v1/chat/completions', async () => {
    const todayPrefix = `Current date: ${new Date().toISOString().slice(0, 10)} (UTC).`;

    // 1. off (default): no date injected even with web_search tool.
    const rOff = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Latest NVIDIA stock?' }],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }],
    }, apiKey);
    expect(rOff.status).toBe(200);
    expect(capturedBodies[0].messages.some((m: any) => String(m.content).includes('Current date:'))).toBe(false);

    // 2. web_search: plain chat stays untouched; web_search tool gets today's date.
    await apiJson('PUT', '/api/settings/system-date', { mode: 'web_search' });
    capturedBodies = [];

    const rPlain = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    }, apiKey);
    expect(rPlain.status).toBe(200);
    expect(capturedBodies[0].messages.some((m: any) => String(m.content).includes('Current date:'))).toBe(false);

    capturedBodies = [];
    const rSearch = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Latest NVIDIA stock?' }],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }],
    }, apiKey);
    expect(rSearch.status).toBe(200);
    expect(capturedBodies[0].messages[0]).toEqual({ role: 'system', content: todayPrefix });

    // 3. always: plain chat gets today's date, but caller-supplied date is not duplicated.
    await apiJson('PUT', '/api/settings/system-date', { mode: 'always' });
    capturedBodies = [];
    const rAlways = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello!' }],
    }, apiKey);
    expect(rAlways.status).toBe(200);
    expect(capturedBodies[0].messages[0]).toEqual({ role: 'system', content: todayPrefix });

    capturedBodies = [];
    const rAlreadyDated = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [
        { role: 'system', content: "Today's date is 2026-11-24." },
        { role: 'user', content: 'Hello!' },
      ],
    }, apiKey);
    expect(rAlreadyDated.status).toBe(200);
    expect(capturedBodies[0].messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
    expect(capturedBodies[0].messages[0].content).toBe("Today's date is 2026-11-24.");
  });

  it('keeps client-profile enforced system prompt first ahead of the injected date', async () => {
    const todayPrefix = `Current date: ${new Date().toISOString().slice(0, 10)} (UTC).`;
    const profileKey = mintClientProfileKey();
    const enc = encrypt(profileKey);
    getDb().prepare(`
      INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled)
      VALUES ('date-order-test', ?, ?, ?, ?, 'STRICT PROFILE PROMPT', 1)
    `).run(hashClientProfileKey(profileKey), enc.encrypted, enc.iv, enc.authTag);

    await apiJson('PUT', '/api/settings/system-date', { mode: 'always' });
    const r = await apiJson('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    }, profileKey);
    expect(r.status).toBe(200);
    expect(capturedBodies[0].messages[0]).toEqual({ role: 'system', content: 'STRICT PROFILE PROMPT' });
    expect(capturedBodies[0].messages[1]).toEqual({ role: 'system', content: todayPrefix });
  });

  it('injects system date on /v1/messages (Anthropic surface) when enabled', async () => {
    const todayPrefix = `Current date: ${new Date().toISOString().slice(0, 10)} (UTC).`;
    await apiJson('PUT', '/api/settings/system-date', { mode: 'always' });

    const r = await origFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'auto',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello from Anthropic client' }],
      }),
    });
    expect(r.status).toBe(200);
    expect(capturedBodies[0].messages[0]).toEqual({ role: 'system', content: todayPrefix });
  });
});
