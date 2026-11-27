import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCooldown, clearAllCooldowns } from '../../services/ratelimit.js';
import { setMonthlyBudgetCaps } from '../../services/key-budget.js';

// Black-box acceptance test for the block cause on image requests (#2061).
// The `pending` marker was removed after implementation.
// No test can reach a real provider: only `google` and `cerebras` keys exist,
// and all dispatch-capable models are blocked before sending (cooldown, quota,
// or no vision in an image request).

function fresh() {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  // The cooldown map lives in the module and survives initDb: clearing avoids
  // a prior case inheriting cooldown and masking the expected cause.
  clearAllCooldowns();
  const app = createApp();
  const token = getUnifiedApiKey();
  return { app, token };
}

function insertKey(platform: string, label: string): number {
  const enc = encrypt('synthetic-acceptance-key');
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, label, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, enc.encrypted, enc.iv, enc.authTag, label).lastInsertRowid);
}

function disableVisionModels(): void {
  getDb().prepare('UPDATE models SET enabled = 0 WHERE supports_vision = 1').run();
}

function cooldownVisionModels(keyId: number): void {
  const rows = getDb().prepare(
    'SELECT platform, model_id FROM models WHERE supports_vision = 1 AND enabled = 1',
  ).all() as Array<{ platform: string; model_id: string }>;
  for (const row of rows) setCooldown(row.platform, row.model_id, keyId, 600_000);
}

function cooldownAllKeyedModels(keyId: number): void {
  const rows = getDb().prepare(
    'SELECT platform, model_id FROM models WHERE enabled = 1',
  ).all() as Array<{ platform: string; model_id: string }>;
  for (const row of rows) setCooldown(row.platform, row.model_id, keyId, 600_000);
}

async function post(app: Express, path: string, body: unknown, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON response */ }
    return {
      status: res.status,
      body: json,
      headers: {
        cause: res.headers.get('x-block-cause'),
        detail: res.headers.get('x-block-cause-detail'),
        vision: res.headers.get('x-vision-model-available'),
      },
    };
  } finally {
    server.close();
  }
}

const PNG_IMAGE = {
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'what is in this image?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
  ] }],
};

const TEXT_ONLY = { messages: [{ role: 'user', content: 'hello' }] };

function responsesImage(imageUrl: string) {
  return { input: [{ role: 'user', content: [
    { type: 'input_text', text: 'what is in this image?' },
    { type: 'input_image', image_url: imageUrl },
  ] }] };
}

describe('explicit block cause with image in history (#2061)', () => {
  it('image PNG without vision model enabled: 422 no_vision_model', async () => {
    const { app, token } = fresh();
    disableVisionModels();

    const res = await post(app, '/v1/chat/completions', PNG_IMAGE, token);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('no_vision_model');
    expect(res.body.error.message).toBeDefined();
    // Upstream: no X-Vision-Model-Available header in 422
    expect(res.headers.vision).not.toBe('false');
    // Upstream: no X-Block-Cause or X-Vision-Model-Available headers in 422
    expect(res.headers.cause).not.toBe('no_vision_model');
    expect(res.headers['x-block-cause']).not.toBe('no_vision_model');
    expect(res.body.execution_id).toBeTruthy();
  });

  it('vision model in cooldown: vision_quota_exhausted / cooldown', async () => {
    const { app, token } = fresh();
    const keyId = insertKey('google', 'google-vision-cooldown');
    cooldownVisionModels(keyId);

    const res = await post(app, '/v1/chat/completions', PNG_IMAGE, token);

    expect(res.status).toBe(429);
    expect(res.headers.cause).toBe('vision_quota_exhausted');
    expect(res.headers.detail).toBe('cooldown');
    expect(res.body.error.cause).toBe('vision_quota_exhausted');
    expect(res.body.error.cause_detail).toBe('cooldown');
  });

  it('vision model with monthly quota exhausted: detail key_quota', async () => {
    const { app, token } = fresh();
    const keyId = insertKey('google', 'google-vision-capped');
    setMonthlyBudgetCaps(keyId, { tokenCap: 1 });

    const res = await post(app, '/v1/chat/completions', PNG_IMAGE, token);

    expect(res.status).toBe(429);
    expect(res.headers.cause).toBe('vision_quota_exhausted');
    expect(res.headers.detail).toBe('key_quota');
    expect(res.body.error.cause).toBe('vision_quota_exhausted');
    expect(res.body.error.cause_detail).toBe('key_quota');
  });

  it('text with all keys in cooldown: cooldown without detail', async () => {
    const { app, token } = fresh();
    const keyId = insertKey('google', 'google-text-cooldown');
    cooldownAllKeyedModels(keyId);

    const res = await post(app, '/v1/chat/completions', TEXT_ONLY, token);

    expect(res.status).toBe(429);
    expect(res.headers.cause).toBe('cooldown');
    expect(res.headers.detail).toBeNull();
    expect(res.body.error.cause).toBe('cooldown');
    expect(res.body.error.cause_detail).toBeUndefined();
  });

  it('image by URL and in JPEG has the same cause; nothing is downloaded', async () => {
    const { app, token } = fresh();
    const keyId = insertKey('google', 'google-vision-cooldown-url');
    cooldownVisionModels(keyId);

    // The example.invalid host does not resolve: if the gateway tried to download
    // the image, the response would not be the routing block below.
    const byUrl = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'https://example.invalid/a.jpg' } },
      ] }],
    }, token);
    expect(byUrl.status).toBe(429);
    expect(byUrl.headers.cause).toBe('vision_quota_exhausted');
    expect(byUrl.headers.detail).toBe('cooldown');
    expect(byUrl.body.error.cause).toBe('vision_quota_exhausted');
    expect(byUrl.body.error.cause_detail).toBe('cooldown');

    const byJpeg = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } },
      ] }],
    }, token);
    expect(byJpeg.status).toBe(429);
    expect(byJpeg.headers.cause).toBe('vision_quota_exhausted');
    expect(byJpeg.headers.detail).toBe('cooldown');
    expect(byJpeg.body.error.cause).toBe('vision_quota_exhausted');
    expect(byJpeg.body.error.cause_detail).toBe('cooldown');
  });

  it('same causes and headers in /v1/responses', async () => {
    // 1) Without vision model enabled → 422 no_vision_model.
    const first = fresh();
    disableVisionModels();
    const noVision = await post(first.app, '/v1/responses',
      responsesImage('data:image/png;base64,iVBORw0KGgo='), first.token);
    expect(noVision.status).toBe(422);
    expect(noVision.body.error.code).toBe('no_vision_model');
    expect(noVision.body.error.message).toBeDefined();
    // Upstream: no X-Vision-Model-Available header in 422
    expect(noVision.headers.vision).not.toBe('false');
    // Upstream: no X-Block-Cause or X-Vision-Model-Available headers in 422
    expect(noVision.headers.cause).not.toBe('no_vision_model');
    expect(noVision.headers['x-block-cause']).not.toBe('no_vision_model');

    // 2) Vision model in cooldown → vision_quota_exhausted / cooldown.
    const second = fresh();
    const keyId = insertKey('google', 'google-vision-cooldown-responses');
    cooldownVisionModels(keyId);
    const cooled = await post(second.app, '/v1/responses',
      responsesImage('data:image/png;base64,iVBORw0KGgo='), second.token);
    expect(cooled.status).toBe(429);
    expect(cooled.headers.cause).toBe('vision_quota_exhausted');
    expect(cooled.headers.detail).toBe('cooldown');
    expect(cooled.body.error.cause).toBe('vision_quota_exhausted');
    expect(cooled.body.error.cause_detail).toBe('cooldown');
  });
});
