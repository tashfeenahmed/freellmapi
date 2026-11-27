import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { stubPublicDns } from '../helpers/dns.js';

let server: http.Server;
let baseUrl: string;
let apiKey: string;
let origFetch: typeof fetch;
let capturedBodies: Array<Record<string, any>>;

const CUSTOM_GATEWAY = 'https://gateway.example.com/v1';

beforeAll(() => {
  initDb(':memory:');
  const app = createApp();
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  apiKey = getUnifiedApiKey();
  origFetch = globalThis.fetch;

  const enc = encrypt('sk-custom-test-key-123456');
  const keyRow = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'Gateway', ?, ?, ?, 'healthy', 1, ?)
  `).run(enc.encrypted, enc.iv, enc.authTag, CUSTOM_GATEWAY);
  const keyId = Number(keyRow.lastInsertRowid);

  for (const modelId of ['gpt-5', 'my-prod-reasoning']) {
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, endpoint_scope)
      VALUES ('custom', ?, ?, 50, 50, 1, ?, ?)
    `).run(modelId, modelId, keyId, CUSTOM_GATEWAY);
  }
});

afterAll(() => {
  globalThis.fetch = origFetch;
  server?.close();
});

beforeEach(() => {
  stubPublicDns();
  capturedBodies = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return origFetch(input, init);

    const parsed = JSON.parse(String(init?.body ?? '{}'));
    capturedBodies.push(parsed);

    // Strictly emulate OpenAI reasoning models: reject any request carrying `max_tokens`.
    if ('max_tokens' in parsed) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'unsupported_parameter',
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            param: 'max_tokens',
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-2056',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'reasoning ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('Custom provider max_completion_tokens routing (#2056)', () => {
  it('routes Anthropic /v1/messages (Claude Code) to custom gpt-5 using max_completion_tokens on the first try', async () => {
    const res = await origFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'gpt-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Explain recursion briefly.' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.content?.[0]?.text).toBe('reasoning ok');
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].max_completion_tokens).toBe(4096);
    expect(capturedBodies[0]).not.toHaveProperty('max_tokens');
  });

  it('routes /v1/messages to a relabeled custom reasoning deployment by retrying the 400 with max_completion_tokens', async () => {
    const res = await origFetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'my-prod-reasoning',
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'Hello!' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.content?.[0]?.text).toBe('reasoning ok');
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].max_tokens).toBe(2048);
    expect(capturedBodies[1].max_completion_tokens).toBe(2048);
    expect(capturedBodies[1]).not.toHaveProperty('max_tokens');
  });

  it('routes OpenAI /v1/chat/completions to custom gpt-5 with max_completion_tokens intact', async () => {
    const res = await origFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5',
        max_completion_tokens: 1500,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.choices?.[0]?.message?.content).toBe('reasoning ok');
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].max_completion_tokens).toBe(1500);
    expect(capturedBodies[0]).not.toHaveProperty('max_tokens');
  });
});
