import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { setCooldown, clearAllCooldowns } from '../../services/ratelimit.js';
import { setMonthlyBudgetCaps } from '../../services/key-budget.js';

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
  return { status: res.status, body: json, headers: res.headers };
}

function addKey(platform: string, label: string): { id: number } {
  const secret = encrypt('test-key');
  const id = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid;
  return { id: Number(id) };
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

describe('block cause on 429/422 routes', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    // Every scenario owns the whole key pool and model chain. Clear carries
    // from a previous test (cooldown rows, stale keys, enabled models) so the
    // cause comes from this test's setup alone.
    clearAllCooldowns();
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('UPDATE models SET enabled = 0').run();
  });

  afterAll(() => {
    // Restore vision models if they were disabled
    try {
      getDb().prepare("UPDATE models SET enabled = 1 WHERE supports_vision = 1").run();
    } catch {}
  });

  // Case B - image, google key, google vision models in cooldown
  it('image with google vision models in cooldown gives vision_quota_exhausted/cooldown', async () => {
    const db = getDb();
    // Enable only Google vision models (gemini-2.5-flash, gemini-2.5-pro, etc.)
    db.prepare("UPDATE models SET enabled = 0 WHERE platform != 'google'").run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'google' AND supports_vision = 1").run();
    // Keep a text-only peer enabled: its "no vision support" line makes the
    // zero-attempt exhaustion a generic routing_exhausted (not a plain cooldown).
    db.prepare("UPDATE models SET enabled = 1 WHERE model_id = 'gemma-4-31b-it'").run();
    // Add a google key
    const keyId = addKey('google', 'test google');
    // Put all google vision models in cooldown
    const visionModels = db.prepare("SELECT model_id FROM models WHERE platform = 'google' AND supports_vision = 1 AND enabled = 1").all() as { model_id: string }[];
    for (const m of visionModels) {
      setCooldown('google', m.model_id, keyId.id, 600000, 'authoritative');
    }

    const { status, body, headers } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).toBe(429);
    // Upstream routingExhaustionBody returns 'rate_limit_exceeded' for time-bound (cooldown) cases
    expect(body?.error?.code).toBe('rate_limit_exceeded');
    expect(body?.error?.cause).toBe('vision_quota_exhausted');
    expect(body?.error?.cause_detail).toBe('cooldown');
    expect(headers.get('X-Block-Cause')).toBe('vision_quota_exhausted');
    expect(headers.get('X-Block-Cause-Detail')).toBe('cooldown');
    expect(body?.execution_id).toBeDefined();
  });

  // text, cerebras key with models in cooldown
  it('text with cerebras in cooldown gives cooldown cause', async () => {
    const db = getDb();
    // Disable vision models, enable cerebras
    db.prepare("UPDATE models SET enabled = 0 WHERE supports_vision = 1").run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cerebras'").run();
    const keyId = addKey('cerebras', 'test cerebras 2');
    // Put cerebras models in cooldown
    const cerebrasModels = db.prepare("SELECT model_id FROM models WHERE platform = 'cerebras' AND enabled = 1").all() as { model_id: string }[];
    for (const m of cerebrasModels) {
      setCooldown('cerebras', m.model_id, keyId.id, 600000, 'authoritative');
    }

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).toBe(429);
    expect(body?.error?.code).toBe('rate_limit_exceeded');
    expect(body?.error?.cause).toBe('cooldown');
    expect(headers.get('X-Block-Cause')).toBe('cooldown');
    expect(headers.get('Retry-After')).toBeDefined(); // Retry-After present
    expect(body?.execution_id).toBeDefined();
  });

  it('text with cerebras in cooldown on /v1/messages carries the cause in the Anthropic error body', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE supports_vision = 1").run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cerebras'").run();
    const keyId = addKey('cerebras', 'test cerebras messages');
    const cerebrasModels = db.prepare("SELECT model_id FROM models WHERE platform = 'cerebras' AND enabled = 1").all() as { model_id: string }[];
    for (const m of cerebrasModels) {
      setCooldown('cerebras', m.model_id, keyId.id, 600000, 'authoritative');
    }

    const { status, body, headers } = await post(app, '/v1/messages', {
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).toBe(429);
    // Existing Anthropic wire fields unchanged.
    expect(body?.type).toBe('error');
    expect(body?.error?.type).toBe('rate_limit_error');
    expect(body?.error?.code).toBe('rate_limit_exceeded');
    // Additive block cause, same as the OpenAI-shaped surfaces.
    expect(body?.error?.cause).toBe('cooldown');
    expect(body?.error?.cause_detail).toBeUndefined();
    expect(headers.get('X-Block-Cause')).toBe('cooldown');
  });

  // text, cerebras key with tokenCap exhausted
  it('text with cerebras tokenCap exhausted gives key_quota cause', async () => {
    const db = getDb();
    db.prepare("UPDATE models SET enabled = 0 WHERE supports_vision = 1").run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'cerebras'").run();
    const keyId = addKey('cerebras', 'test cerebras 3');
    // Set monthly budget cap to 1 token (will be exhausted)
    setMonthlyBudgetCaps(keyId.id, { tokenCap: 1 });

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).toBe(429);
    expect(body?.error?.code).toBe('quota_exceeded');
    expect(body?.error?.cause).toBe('key_quota');
    expect(headers.get('X-Block-Cause')).toBe('key_quota');
    expect(body?.execution_id).toBeDefined();
  });

  // image and no vision model enabled
  it('image with no vision model enabled gives 422 no_vision_model', async () => {
    const db = getDb();
    // Disable ALL vision models
    db.prepare("UPDATE models SET enabled = 0 WHERE supports_vision = 1").run();

    const { status, body, headers } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).toBe(422);
    expect(body?.error?.code).toBe('no_vision_model');
    expect(body?.error?.message).toBeDefined();
    expect(body?.execution_id).toBeDefined();
    // No X-* keys in body for 422 (upstream behavior)
    // headers.get() returns null when absent
    expect(headers.get('X-Vision-Model-Available')).toBeNull();
    expect(headers.get('X-Block-Cause')).toBeNull();
  });

  // Case B in /v1/responses
  it('image with google vision models in cooldown on /v1/responses', async () => {
    const db = getDb();
    // Re-enable google vision models and put in cooldown
    db.prepare("UPDATE models SET enabled = 0 WHERE platform != 'google'").run();
    db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'google' AND supports_vision = 1").run();
    const keyId = addKey('google', 'test google 2');
    const visionModels = db.prepare("SELECT model_id FROM models WHERE platform = 'google' AND supports_vision = 1 AND enabled = 1").all() as { model_id: string }[];
    for (const m of visionModels) {
      setCooldown('google', m.model_id, keyId.id, 600000, 'authoritative');
    }

    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'what is this?' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] }] }),
    });
    const text = await res.text();
    server.close();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}

    expect(res.status).toBe(429);
    expect(json?.error?.cause).toBe('vision_quota_exhausted');
    expect(json?.error?.cause_detail).toBe('cooldown');
    expect(res.headers.get('X-Block-Cause')).toBe('vision_quota_exhausted');
    expect(res.headers.get('X-Block-Cause-Detail')).toBe('cooldown');
    // /v1/responses carries the trace id as X-Request-ID; unlike
    // /v1/chat/completions, its exhaustion body has no execution_id.
    // Headers.get() returns null when absent; toBeDefined() would pass on null.
    expect(res.headers.get('X-Request-ID')).not.toBeNull();
  });

  // proxy-vision tests still pass (no change needed here, just verify)
  it('vision routing still works when vision models with keys are available', async () => {
    const db = getDb();
    // Enable vision models and add a key for one so routable > 0 (gate passes)
    db.prepare("UPDATE models SET enabled = 1 WHERE supports_vision = 1").run();
    db.prepare("UPDATE api_keys SET enabled = 0").run(); // Disable all keys
    // Add a google key for a vision model
    const _keyId = addKey('google', 'test google vision');

    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    // Gate passes (routable > 0), routing handles it (no keys for other models → 429)
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
  });
});
