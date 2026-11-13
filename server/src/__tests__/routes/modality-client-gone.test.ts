import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

// The non-chat failover routes must honour a client that hangs up: when the
// caller disconnects while provider #1 is still working and provider #1 then
// fails, the gateway must NOT fail over to provider #2 (a second upstream call
// nobody is waiting for), and the attempt that was in flight is logged
// 'canceled' — never 'error' or 'success'.

const realFetch = globalThis.fetch;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

function addCustomKey(baseUrl: string, raw = 'custom-test-key'): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  return Number(row.lastInsertRowid);
}

function addMedia(platform: string, modelId: string, modality: string, priority: number, meta: object | null = null) {
  getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, ?, ?, 1, '', ?)
  `).run(platform, modelId, modelId, modality, priority, meta ? JSON.stringify(meta) : null);
}

function addEmbedding(platform: string, modelId: string, priority: number) {
  getDb().prepare(`
    INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
    VALUES ('cg-embed', ?, ?, ?, 2, ?, 1, '')
  `).run(platform, modelId, modelId, priority);
}

interface Surface {
  name: string;
  path: string;
  setup: () => void;
  /** substring of the provider URL that identifies provider #1 / #2 */
  p1: string;
  p2: string;
  p2Response: () => Response;
  request: () => RequestInit;
  logsRequests: boolean;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const jsonReq = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const surfaces: Surface[] = [
  {
    name: '/v1/embeddings',
    path: '/v1/embeddings',
    setup: () => {
      addKey('openrouter');
      addKey('nvidia');
      addEmbedding('openrouter', 'cg/embed-a', 1);
      addEmbedding('nvidia', 'cg/embed-b', 2);
    },
    p1: 'openrouter.ai/api/v1/embeddings',
    p2: 'integrate.api.nvidia.com/v1/embeddings',
    p2Response: () => json({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } }),
    request: () => jsonReq({ model: 'cg-embed', input: 'hello' }),
    logsRequests: true,
  },
  {
    name: '/v1/rerank',
    path: '/v1/rerank',
    setup: () => {
      addCustomKey('https://rerank-a.example/v1'); // custom endpoints are tried first
      addKey('cohere');
    },
    p1: 'rerank-a.example/v1/rerank',
    p2: 'api.cohere.com/v2/rerank',
    p2Response: () => json({ results: [{ index: 0, relevance_score: 0.9 }] }),
    request: () => jsonReq({ query: 'q', documents: ['a', 'b'] }),
    logsRequests: false,
  },
  {
    name: '/v1/moderations',
    path: '/v1/moderations',
    setup: () => {
      addKey('openai');
      addKey('openrouter');
    },
    p1: 'api.openai.com/v1/moderations',
    p2: 'openrouter.ai/api/v1/moderations',
    p2Response: () => json({ id: 'modr-test', results: [{ flagged: false }] }),
    request: () => jsonReq({ input: 'hello' }),
    logsRequests: true,
  },
  {
    name: '/v1/images/generations',
    path: '/v1/images/generations',
    setup: () => {
      addKey('nvidia');
      addMedia('pollinations', 'flux', 'image', 1); // keyless
      addMedia('nvidia', 'black-forest-labs/flux.1-schnell', 'image', 2);
    },
    p1: 'image.pollinations.ai',
    p2: 'ai.api.nvidia.com',
    p2Response: () => json({ artifacts: [{ base64: 'AAAA' }] }),
    request: () => jsonReq({ prompt: 'a cat' }),
    logsRequests: true,
  },
  {
    name: '/v1/audio/speech',
    path: '/v1/audio/speech',
    setup: () => {
      addKey('siliconflow');
      addMedia('pollinations', 'openai-audio', 'audio', 1); // keyless
      addMedia('siliconflow', 'FunAudioLLM/CosyVoice2-0.5B', 'audio', 2);
    },
    p1: 'gen.pollinations.ai/v1/chat/completions',
    p2: 'api.siliconflow.com/v1/audio/speech',
    p2Response: () => new Response(Buffer.from('ID3fakeaudiobytes'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    request: () => jsonReq({ input: 'hello' }),
    logsRequests: true,
  },
  {
    name: '/v1/audio/transcriptions',
    path: '/v1/audio/transcriptions',
    setup: () => {
      addKey('groq');
      addKey('cloudflare', 'acct:token');
      addMedia('groq', 'whisper-large-v3-turbo', 'transcription', 0, { maxBytes: 25 * 1024 * 1024 });
      addMedia('cloudflare', '@cf/openai/whisper-large-v3-turbo', 'transcription', 1, { requestStyle: 'json' });
    },
    p1: 'api.groq.com/openai/v1/audio/transcriptions',
    p2: 'api.cloudflare.com',
    p2Response: () => json({ result: { text: 'hi' } }),
    request: () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('RIFFfakewavbytes')], { type: 'audio/wav' }), 'a.wav');
      form.append('model', 'auto');
      return { method: 'POST', body: form };
    },
    logsRequests: true,
  },
];

describe('non-chat failover routes honour a client that hung up', () => {
  let app: Express;
  let gate!: () => void;
  let gatePromise: Promise<void>;
  let p1Calls: number;
  let p1Done: boolean;
  let p2Calls: number;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    p1Calls = 0;
    p1Done = false;
    p2Calls = 0;
    gatePromise = new Promise<void>(r => { gate = r; });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each(surfaces)('$name: no failover to provider #2 and the in-flight attempt is logged canceled', async (s) => {
    s.setup();
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) return realFetch(input, init);
      if (url.includes(s.p1)) {
        p1Calls++;
        await gatePromise; // released by the test right after the hang-up
        await sleep(50); // let the server notice the socket closing
        p1Done = true;
        return new Response('upstream unavailable', { status: 502 });
      }
      if (url.includes(s.p2)) {
        p2Calls++;
        return s.p2Response();
      }
      throw new Error(`unexpected URL in client-gone test: ${url}`);
    }) as typeof fetch;

    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
    const port = (server.address() as AddressInfo).port;
    const init = s.request();
    const abort = new AbortController();
    const pending = realFetch(`http://127.0.0.1:${port}${s.path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${getUnifiedApiKey()}` },
      signal: abort.signal,
    }).catch(() => null);

    try {
      for (let i = 0; i < 200 && p1Calls === 0; i++) await sleep(10);
      expect(p1Calls).toBe(1); // setup sanity: provider #1 is in flight

      abort.abort(); // the client hangs up
      await pending;
      gate();

      for (let i = 0; i < 200 && !p1Done; i++) await sleep(10);
      expect(p1Done).toBe(true);
      await sleep(200); // let the server loop settle (fail over, log)

      expect(p2Calls).toBe(0);
      if (s.logsRequests) {
        const statuses = (getDb().prepare('SELECT status FROM requests ORDER BY id').all() as { status: string }[]).map(r => r.status);
        expect(statuses).toEqual(['canceled']);
      }
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
