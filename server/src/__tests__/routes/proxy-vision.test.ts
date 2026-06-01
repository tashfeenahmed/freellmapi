import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
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

  it('lets an image request through routing when a vision model is enabled (no 422)', async () => {
    // Seed has Gemini/Llama-4 vision models enabled but no provider keys, so
    // routing exhausts → 429. The point: it is NOT the 422 "no vision model"
    // error, proving the precheck passed and routing was attempted.
    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
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
});
