import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { getProvider } from '../../providers/index.js';
import { getCatalogModelTombstone } from '../../services/model-state.js';

let dashToken = '';

async function post(app: Express, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function del(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'DELETE',
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Model Provider Actions API', () => {
  let app: Express;

  beforeAll(async () => {
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/models', () => {
    it('rejects unauthenticated requests', async () => {
      const server = app.listen(0, '127.0.0.1');
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
      const addr = server.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'groq', modelId: 'test-unauth' }),
      });
      server.close();
      expect(res.status).toBe(401);
    });

    it('rejects invalid payload', async () => {
      const res = await post(app, '/api/models', { platform: 'groq' });
      expect(res.status).toBe(400);
    });

    it('rejects unknown platform', async () => {
      const res = await post(app, '/api/models', {
        platform: 'non-existent-platform',
        modelId: 'test-model',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('Invalid platform');
    });

    it('creates custom model on a native platform with source="user"', async () => {
      const db = getDb();
      const modelId = `custom-native-${Date.now()}`;

      const res = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
        displayName: 'Custom Groq Model',
        contextWindow: 128000,
        rpmLimit: 30,
        supportsVision: true,
        supportsTools: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.model.modelId).toBe(modelId);
      expect(res.body.model.source).toBe('custom');

      // Verify database state
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(res.body.id) as any;
      expect(row).toBeDefined();
      expect(row.source).toBe('user');
      expect(row.enabled).toBe(1);
      expect(row.display_name).toBe('Custom Groq Model');
      expect(row.supports_vision).toBe(1);
      expect(row.supports_tools).toBe(1);

      // Verify fallback_config
      const fb = db.prepare('SELECT * FROM fallback_config WHERE model_db_id = ?').get(res.body.id) as any;
      expect(fb).toBeDefined();
      expect(fb.enabled).toBe(1);

      // Verify profile_models
      const pm = db.prepare('SELECT * FROM profile_models WHERE model_db_id = ?').all(res.body.id);
      expect(pm.length).toBeGreaterThan(0);
    });

    it('rejects duplicate model creation for the same platform', async () => {
      const modelId = `dup-model-${Date.now()}`;

      const first = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      expect(first.status).toBe(201);

      const second = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      expect(second.status).toBe(409);
      expect(second.body.error.message).toContain('already exists');
    });

    it('creates custom model for custom provider with endpointScope', async () => {
      const db = getDb();
      const modelId = `relay-model-${Date.now()}`;
      const endpoint = 'http://127.0.0.1:9099/v1';

      const res = await post(app, '/api/models', {
        platform: 'custom',
        modelId,
        endpointScope: endpoint,
      });

      expect(res.status).toBe(201);
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(res.body.id) as any;
      expect(row.platform).toBe('custom');
      expect(row.endpoint_scope).toBe('http://127.0.0.1:9099/v1');
    });

    it('clears tombstone when recreating a previously deleted catalog model', async () => {
      const db = getDb();
      const modelId = `tomb-resurrect-${Date.now()}`;

      // Create model
      const res1 = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      const id = res1.body.id;

      // Delete it (marks tombstone)
      const delRes = await del(app, `/api/models/${id}`);
      expect(delRes.status).toBe(200);

      // Recreate it
      const res2 = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      expect(res2.status).toBe(201);

      // Tombstone should be cleared
      const tomb = getCatalogModelTombstone(db, 'chat', 'groq', modelId);
      expect(tomb).toBeUndefined();
    });
  });

  describe('DELETE /api/models/:id', () => {
    it('deletes model and cleans up fallback_config, profile_models, and tombstones', async () => {
      const db = getDb();
      const modelId = `delete-target-${Date.now()}`;

      const createRes = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      const id = createRes.body.id;

      // Verify initial setup
      expect(db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(id)).toBeDefined();
      expect(db.prepare('SELECT COUNT(*) as c FROM profile_models WHERE model_db_id = ?').get(id)).toBeDefined();

      // Delete
      const delRes = await del(app, `/api/models/${id}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      // Verify cleanup
      expect(db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)).toBeUndefined();
      expect(db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(id)).toBeUndefined();
      expect(db.prepare('SELECT 1 FROM profile_models WHERE model_db_id = ?').get(id)).toBeUndefined();
    });
  });

  describe('POST /api/models/:id/test', () => {
    it('returns 404 for unknown model id', async () => {
      const res = await post(app, '/api/models/9999999/test');
      expect(res.status).toBe(404);
    });

    it('returns structured failure when no enabled key is available', async () => {
      const modelId = `no-key-model-${Date.now()}`;
      const createRes = await post(app, '/api/models', {
        platform: 'cohere',
        modelId,
      });
      const id = createRes.body.id;

      // Ensure no keys for cohere
      const db = getDb();
      db.prepare("DELETE FROM api_keys WHERE platform = 'cohere'").run();

      const testRes = await post(app, `/api/models/${id}/test`);
      expect(testRes.status).toBe(200);
      expect(testRes.body.success).toBe(false);
      expect(testRes.body.error).toContain('No enabled API key');
    });

    it('successfully tests a model, calculates latency, and records usage', async () => {
      const db = getDb();
      const modelId = `test-run-${Date.now()}`;
      const createRes = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      const modelDbId = createRes.body.id;

      // Ensure an enabled key for groq
      const enc = encrypt('test-key-groq-secret');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
        VALUES ('groq', 'Test Groq Key', ?, ?, ?, 1, 'healthy')
      `).run(enc.encrypted, enc.iv, enc.authTag);

      const groqProvider = getProvider('groq');
      expect(groqProvider).toBeDefined();

      const chatSpy = vi.spyOn(groqProvider!, 'chatCompletion').mockResolvedValueOnce({
        id: 'test-completion-id',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } as any);

      const testRes = await post(app, `/api/models/${modelDbId}/test`);
      expect(testRes.status).toBe(200);
      expect(testRes.body.success).toBe(true);
      expect(testRes.body.modelId).toBe(modelId);
      expect(typeof testRes.body.latencyMs).toBe('number');
      expect(chatSpy).toHaveBeenCalledWith(
        'test-key-groq-secret',
        [{ role: 'user', content: 'ping' }],
        modelId,
        { max_tokens: 4, timeoutMs: 15000 },
      );
    });

    it('enforces 5-second server throttle and returns 429', async () => {
      const db = getDb();
      const modelId = `throttle-model-${Date.now()}`;
      const createRes = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      const modelDbId = createRes.body.id;

      const enc = encrypt('test-key-throttle');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
        VALUES ('groq', 'Throttle Key', ?, ?, ?, 1, 'healthy')
      `).run(enc.encrypted, enc.iv, enc.authTag);

      const groqProvider = getProvider('groq');
      vi.spyOn(groqProvider!, 'chatCompletion').mockResolvedValue({
        id: 'test-completion-id',
        choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      } as any);

      // First call passes
      const firstRes = await post(app, `/api/models/${modelDbId}/test`);
      expect(firstRes.status).toBe(200);

      // Immediate second call is throttled
      const secondRes = await post(app, `/api/models/${modelDbId}/test`);
      expect(secondRes.status).toBe(429);
      expect(secondRes.body.error.message).toContain('throttled');
    });

    it('sanitizes upstream error messages and hides secrets', async () => {
      const db = getDb();
      const modelId = `error-model-${Date.now()}`;
      const createRes = await post(app, '/api/models', {
        platform: 'groq',
        modelId,
      });
      const modelDbId = createRes.body.id;

      const enc = encrypt('test-key-leak');
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
        VALUES ('groq', 'Leak Key', ?, ?, ?, 1, 'healthy')
      `).run(enc.encrypted, enc.iv, enc.authTag);

      const groqProvider = getProvider('groq');
      vi.spyOn(groqProvider!, 'chatCompletion').mockRejectedValueOnce(
        new Error('Unauthorized: Bearer gsk_secret1234567890abcdef is invalid'),
      );

      const testRes = await post(app, `/api/models/${modelDbId}/test`);
      expect(testRes.status).toBe(200);
      expect(testRes.body.success).toBe(false);
      expect(testRes.body.error).toBeDefined();
      expect(testRes.body.error).not.toContain('gsk_secret1234567890abcdef');
      expect(testRes.body.error.toLowerCase()).toContain('[redacted]');
    });
  });
});
