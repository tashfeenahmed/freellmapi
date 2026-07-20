import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

// Covers scoped-model-routing spec across all three protocol entry points.
// Uses empty-scope (no members) so 503 scope_exhausted fires BEFORE any
// provider call - the test asserts the parsing + exhaustion path, not live
// provider behavior.
async function call(app: Express, path: string, body: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('scoped model routing across three entry points', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    // An enabled alias with NO member models -> empty scope.
    db.prepare('INSERT INTO aliases (name, level, priority, enabled) VALUES (?, ?, 0, 1)').run('empty-alias', 'high');
    app = createApp();
  });

  describe('POST /v1/chat/completions (OpenAI)', () => {
    it('empty alias scope -> 503 scope_exhausted', async () => {
      const r = await call(app, '/v1/chat/completions', {
        model: 'empty-alias',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('scope_exhausted');
    });

    it('empty level scope -> 503 scope_exhausted', async () => {
      const r = await call(app, '/v1/chat/completions', {
        model: 'low-level',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('scope_exhausted');
    });

    it('non-existent model -> 400 model_not_found (pin path)', async () => {
      const r = await call(app, '/v1/chat/completions', {
        model: 'ghost-model-xyz',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('model_not_found');
    });
  });

  describe('POST /v1/messages (Anthropic)', () => {
    it('empty alias scope -> 503 scope_exhausted', async () => {
      const r = await call(app, '/v1/messages', {
        model: 'empty-alias',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.status).toBe(503);
      expect(r.body.error.type).toBe('scope_exhausted');
    });

    it('non-existent model -> 400 (pin path)', async () => {
      const r = await call(app, '/v1/messages', {
        model: 'ghost-model-xyz',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(r.status).toBe(400);
    });
  });

  describe('POST /v1/responses (Responses API)', () => {
    it('empty alias scope -> 503 scope_exhausted', async () => {
      const r = await call(app, '/v1/responses', {
        model: 'empty-alias',
        input: 'hi',
      });
      expect(r.status).toBe(503);
      expect(r.body.error.type).toBe('scope_exhausted');
    });

    it('non-existent model -> 400 model_not_found (pin path)', async () => {
      const r = await call(app, '/v1/responses', {
        model: 'ghost-model-xyz',
        input: 'hi',
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('model_not_found');
    });
  });
});
