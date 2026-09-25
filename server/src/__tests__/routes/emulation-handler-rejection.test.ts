import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

// Fails the first thing `runInboundChat` awaits, so the handler promise
// rejects AFTER the synchronous part of the Express handler has returned —
// exactly the shape Express can only see when the handler hands it the
// promise. The flag keeps every other test on the real implementation.
let failNormalize = false;
vi.mock('../../lib/image-normalize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/image-normalize.js')>();
  return {
    ...actual,
    normalizeMessageImages: async (...args: Parameters<typeof actual.normalizeMessageImages>) => {
      if (failNormalize) throw new Error('boom from image normalization');
      return actual.normalizeMessageImages(...args);
    },
  };
});

const { createApp } = await import('../../app.js');
const { getDb, getUnifiedApiKey, initDb, setSetting } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');

async function request(
  app: Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, body: json };
  } finally {
    server.close();
  }
}

// A handler that voids its promise never answers and never reaches
// errorHandler: the request hangs until the client gives up, and the
// rejection escapes to `unhandledRejection`, which lib/process-safety-net.ts
// treats as fatal for non-transport errors. Both surfaces must answer 500.
describe('emulation surfaces forward handler rejections to the error handler', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    const key = encrypt('gsk_handler_rejection_test');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'rejection-test', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);
    failNormalize = true;
  });

  afterEach(() => {
    failNormalize = false;
    setSetting('ollama_emulation', 'off');
    vi.restoreAllMocks();
  });

  it('answers 500 on the Gemini generateContent surface', async () => {
    const response = await request(
      app,
      `/v1beta/models/gemini-2.5-flash:generateContent?key=${getUnifiedApiKey()}`,
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    );
    expect(response.status).toBe(500);
    expect(response.body?.error).toBeTruthy();
  });

  it('answers 500 on the Ollama chat surface', async () => {
    setSetting('ollama_emulation', 'key-required');
    const response = await request(
      app,
      '/api/chat',
      { model: 'auto', messages: [{ role: 'user', content: 'hello' }], stream: false },
      { Authorization: `Bearer ${getUnifiedApiKey()}` },
    );
    expect(response.status).toBe(500);
    expect(response.body?.error).toBeTruthy();
  });

  it('answers 500 on the Ollama generate surface', async () => {
    setSetting('ollama_emulation', 'key-required');
    const response = await request(
      app,
      '/api/generate',
      { model: 'auto', prompt: 'hello', stream: false },
      { Authorization: `Bearer ${getUnifiedApiKey()}` },
    );
    expect(response.status).toBe(500);
    expect(response.body?.error).toBeTruthy();
  });
});
