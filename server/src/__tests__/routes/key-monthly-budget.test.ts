import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { nextMonthResetAt } from '../../services/key-budget.js';

let server: Server;
let baseUrl: string;
let token: string;
let model: string;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  const secret = encrypt('synthetic-budget-test-key');
  const keyId = Number(db.prepare(`INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled, status, monthly_request_cap)
    VALUES ('groq', ?, ?, ?, 1, 'healthy', 1)`).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
  model = (db.prepare("SELECT model_id FROM models WHERE platform = 'groq' LIMIT 1").get() as { model_id: string }).model_id;
  db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms)
    VALUES ('groq', ?, ?, 'success', 10, 5, 1)`).run(model, keyId);
  db.prepare(`INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
    VALUES ('budget-embedding', 'custom', 'budget-embedding', 'Budget embedding', 2, 1, 1, '', ?)`).run(keyId);
  for (const modality of ['image', 'video', 'audio', 'transcription']) {
    db.prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
      VALUES ('custom', ?, 'Budget media', ?, 1, 1, '', ?)`).run(`budget-${modality}`, modality, keyId);
  }
  setSetting('ollama_emulation', 'key-required');
  token = getUnifiedApiKey();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

describe('monthly budget exhaustion on inference endpoints', () => {
  it.each([
    ['/v1/embeddings', { model: 'budget-embedding', input: 'hello' }],
    ['/v1/images/generations', { model: 'budget-image', prompt: 'hello' }],
    ['/v1/videos/generations', { model: 'budget-video', prompt: 'hello' }],
    ['/v1/audio/speech', { model: 'budget-audio', input: 'hello' }],
    ['/api/embed', { model: 'budget-embedding', input: 'hello' }],
  ])('%s also enforces the shared key budget', async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(429);
    if (path !== '/api/embed') expect((await res.json()).error.code).toBe('quota_exceeded');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('enforces the budget on multipart transcription requests', async () => {
    const body = new FormData();
    body.set('model', 'budget-transcription');
    body.set('file', new Blob(['synthetic audio'], { type: 'audio/wav' }), 'test.wav');
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('quota_exceeded');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it.each(['/v1/chat/completions', '/v1/responses'])('Fusion through %s cannot bypass a capped provider key', async path => {
    const input = path === '/v1/responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] };
    const before = getDb().prepare('SELECT SUM(requests) AS requests FROM key_monthly_usage').get();
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, model: 'fusion', fusion: { models: [model] }, max_tokens: 20 }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.type).toBe('rate_limit_error');
    expect(getDb().prepare('SELECT SUM(requests) AS requests FROM key_monthly_usage').get()).toEqual(before);
  });

  it.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])('%s returns quota_exceeded and the month reset header', async path => {
    const input = path === '/v1/responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] };
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, model, max_tokens: 20 }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    // Anthropic translates the error type but keeps the shared retry header.
    if (path !== '/v1/messages') expect(body.error.code).toBe('quota_exceeded');
    const retry = Number(res.headers.get('Retry-After'));
    const expected = Math.ceil((Date.parse(nextMonthResetAt()) - Date.now()) / 1000);
    expect(retry).toBeGreaterThanOrEqual(expected - 1);
    expect(retry).toBeLessThanOrEqual(expected + 1);
  });
});
