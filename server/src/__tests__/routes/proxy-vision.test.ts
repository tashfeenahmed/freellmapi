import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCooldown } from '../../services/ratelimit.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

const IMAGE_MESSAGE = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }],
};

const HISTORY_IMAGE_MESSAGE = {
  model: 'auto',
  messages: [
    IMAGE_MESSAGE.messages[0],
    { role: 'assistant', content: 'A single pixel.' },
    { role: 'user', content: 'thanks, now tell me a joke' },
  ],
};

describe('Vision-aware routing (#118, #125)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('seeds supports_vision: true for vision models, false for text-only', () => {
    const db = getDb();
    const vision = db.prepare("SELECT supports_vision FROM models WHERE model_id = 'gemini-2.5-flash'").get() as { supports_vision: number };
    expect(vision.supports_vision).toBe(1);

    // The known vision set is flagged; plenty of text-only models remain at 0.
    const visionCount = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_vision = 1').get() as { c: number }).c;
    const textCount = (db.prepare('SELECT COUNT(*) c FROM models WHERE supports_vision = 0').get() as { c: number }).c;
    expect(visionCount).toBeGreaterThanOrEqual(4);
    expect(textCount).toBeGreaterThan(0);
  });

  // #2061/#2062: the seed enables plenty of vision models but configures no
  // provider key, so none can be routed to. That used to pass the "enabled"
  // gate and come back as a 429 "All models exhausted", which reads as a quota
  // problem. Follow-up turns re-send the image in history, which is the common
  // way to hit it.
  it('rejects an image in re-sent history with 422 when no vision model has a usable key', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const { status, body } = await post(app, '/v1/chat/completions', HISTORY_IMAGE_MESSAGE, key);
      expect(status).toBe(422);
      expect(body.error.code).toBe('no_vision_model');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toMatch(/earlier turn of the conversation history/);
      expect(body.error.message).toMatch(/has a usable API key/);
      const line = warn.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[vision]'));
      expect(line).toMatch(/event=history_vision_blocked/);
      expect(line).toMatch(/image_in_history=true/);
      expect(line).toMatch(/vision_models_available=0/);
    } finally {
      warn.mockRestore();
    }
  });

  it('gives the same 422 on the Anthropic /v1/messages wire (image block in history)', async () => {
    const { status, body } = await post(app, '/v1/messages', {
      model: 'auto',
      max_tokens: 64,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ] },
        { role: 'assistant', content: [{ type: 'text', text: 'A pixel.' }] },
        { role: 'user', content: 'thanks, now a joke' },
      ],
    }, key);
    expect(status).toBe(422);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('no_vision_model');
  });

  it('gives the same 422 on /v1/responses (input_image in history)', async () => {
    const { status, body } = await post(app, '/v1/responses', {
      model: 'auto',
      input: [
        { role: 'user', content: [
          { type: 'input_text', text: 'what is in this image?' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        ] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'A pixel.' }] },
        { role: 'user', content: 'thanks, now a joke' },
      ],
    }, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_vision_model');
  });

  it('lets an image request through to routing once a vision model has a key; all rate-limited is a 429 that says so', async () => {
    // A Google key makes the Gemini vision models routable. Cool every Google
    // model down on it so routing exhausts without any network call: the
    // request must reach the router (no 422) and the 429 must name vision.
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('AIza-test');
    const keyId = Number(db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'g', ?, ?, ?, 'healthy', 1)",
    ).run(encrypted, iv, authTag).lastInsertRowid);
    const googleModels = db.prepare("SELECT model_id FROM models WHERE platform = 'google'").all() as { model_id: string }[];
    for (const m of googleModels) setCooldown('google', m.model_id, keyId, 3_600_000);

    const { status, body } = await post(app, '/v1/chat/completions', HISTORY_IMAGE_MESSAGE, key);
    expect(status).toBe(429);
    expect(body?.error?.code).not.toBe('no_vision_model');
    expect(body.error.message).toMatch(/vision-capable models are rate-limited/);
  });

  it('rejects an image request with a clear 422 when no vision model is enabled', async () => {
    // Disable every vision-capable model in the chain.
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_vision = 1').run();

    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_vision_model');
    expect(body.error.type).toBe('invalid_request_error');

    // Restore so we don't leak state to other expectations.
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_vision = 1').run();
  });

  it('does not apply the vision gate to a text-only request', async () => {
    // Disable all vision models; a plain text request must still route normally
    // (it 429s on exhaustion here, but never the 422 vision error).
    getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_vision = 1').run();
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
    getDb().prepare('UPDATE models SET enabled = 1 WHERE supports_vision = 1').run();
  });

  it('lets a fusion image request through routing (no 422 fusion_no_vision)', async () => {
    // Same seed as the auto case: vision models enabled but no provider keys,
    // so routing exhausts. The point is that fusion is NOT rejected up front.
    const { status, body } = await post(app, '/v1/chat/completions', { ...IMAGE_MESSAGE, model: 'fusion' }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('fusion_no_vision');
  });
});
