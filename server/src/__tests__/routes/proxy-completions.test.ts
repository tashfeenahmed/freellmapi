import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setRoutingStrategy } from '../../services/router.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

describe('POST /v1/completions', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare("UPDATE fallback_config SET priority = 1 WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'groq' LIMIT 1)").run();

    const key = encrypt('gsk_completion_test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'completion-test', ?, ?, ?, 'healthy', 1)
    `).run(key.encrypted, key.iv, key.authTag);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adapts a legacy text completion request into a routed chat completion response for autocomplete clients', async () => {
    let capturedBody: any = null;
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        capturedBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-completion',
            object: 'chat.completion',
            created: 123,
            model: capturedBody.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: ' = 42;' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body, headers } = await request(app, 'POST', '/v1/completions', {
      model: 'auto',
      prompt: 'const answer',
      suffix: '\nconsole.log(answer);',
      max_tokens: 12,
      temperature: 0.2,
      stop: ['\n\n'],
    }, authHeaders());

    expect(status).toBe(200);
    expect(headers.get('x-routed-via')).toContain('groq/');
    expect(body).toMatchObject({
      id: 'cmpl-chatcmpl-completion',
      object: 'text_completion',
      choices: [{ index: 0, text: ' = 42;', finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    expect(capturedBody.max_tokens).toBe(12);
    expect(capturedBody.temperature).toBe(0.2);
    expect(capturedBody.stop).toEqual(['\n\n']);
    expect(capturedBody.messages[0].role).toBe('system');
    expect(capturedBody.messages[1].content).toContain('const answer');
    expect(capturedBody.messages[1].content).toContain('console.log(answer);');
  });

  it('accepts autocomplete clients that send more than four stop sequences and forwards a provider-safe subset', async () => {
    let capturedBody: any = null;
    const origFetch = global.fetch;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        capturedBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-stop',
            object: 'chat.completion',
            created: 123,
            model: capturedBody.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'suggestion' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/completions', {
      model: 'auto',
      prompt: 'function demo() {',
      max_tokens: 16,
      stop: ['\n', '}', ';', '<|end|>', '<|fim_suffix|>', '<|fim_middle|>'],
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].text).toBe('suggestion');
    expect(capturedBody.stop).toEqual(['\n', '}', ';', '<|end|>']);
  });

});
