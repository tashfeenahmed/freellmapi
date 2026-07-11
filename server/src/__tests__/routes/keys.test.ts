import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
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

async function multipartRequest(
  app: Express,
  path: string,
  field: 'file' | 'files',
  files: Array<{ filename: string; content: string; type?: string }>,
) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const form = new FormData();
  for (const file of files) {
    form.append(
      field,
      new Blob([file.content], { type: file.type ?? 'text/plain' }),
      file.filename,
    );
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: form,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Keys API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'My Groq Key',
    });

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys warns when the platform has no catalog models yet (#438)', async () => {
    const db = getDb();
    // Simulate the Agnes case: a registered platform whose models aren't in
    // this install's catalog tier. Force it by disabling every agnes row (a
    // fresh migrated DB already has zero agnes models, but be explicit).
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'agnes'").run();

    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'agnes',
      key: 'agnes_test_key_123456',
    });
    expect(status).toBe(201);
    expect(body.modelsAvailable).toBe(0);
    expect(body.notice).toBeTruthy();
    expect(body.notice).toMatch(/no agnes models/i);
  });

  it('POST /api/keys does not warn when the platform has catalog models', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });
    expect(status).toBe(201);
    expect(body.modelsAvailable).toBeGreaterThan(0);
    expect(body.notice ?? null).toBeNull();
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'invalid_platform',
      key: 'test',
    });
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'DELETE', `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/keys');
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'DELETE', '/api/keys/99999');
    expect(status).toBe(404);
  });

  it('PATCH /api/keys/:id updates label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      label: 'Production key',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe('Production key');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].label).toBe('Production key');
  });

  it('PATCH /api/keys/:id updates both enabled and label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      enabled: false,
      label: 'Disabled key',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.label).toBe('Disabled key');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].enabled).toBe(false);
    expect(keys[0].label).toBe('Disabled key');
  });

  it('PATCH /api/keys/:id clears label', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
      label: 'Temporary label',
    });

    const { status, body } = await request(app, 'PATCH', `/api/keys/${created.id}`, {
      label: '',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe('');

    const { body: keys } = await request(app, 'GET', '/api/keys');
    expect(keys[0].label).toBe('');
  });

  it('PATCH /api/keys/:id returns 400 when no fields provided', async () => {
    const { body: created } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_test123456789',
    });

    const { status } = await request(app, 'PATCH', `/api/keys/${created.id}`, {});
    expect(status).toBe(400);
  });

  it('PATCH /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await request(app, 'PATCH', '/api/keys/99999', { label: 'test' });
    expect(status).toBe(404);
  });

  describe('key import', () => {
    it('previews keys from multiple supported files', async () => {
      const { status, body } = await multipartRequest(app, '/api/keys/preview', 'files', [
        { filename: 'keys.env', content: 'GROQ_API_KEY=gsk_test123\nANTHROPIC_API_KEY=sk-ant-test' },
        { filename: 'more.jsonc', content: '{ // comment\n "MISTRAL_API_KEY": "mist_test456",\n}' },
      ]);

      expect(status).toBe(200);
      expect(body.keys).toEqual([
        { keyName: 'GROQ_API_KEY', keyValue: 'gsk_test123', detectedPlatform: 'groq', prefix: 'GROQ_', isDuplicate: false },
        { keyName: 'ANTHROPIC_API_KEY', keyValue: 'sk-ant-test', detectedPlatform: null, prefix: 'ANTHROPIC_', isDuplicate: false },
        { keyName: 'MISTRAL_API_KEY', keyValue: 'mist_test456', detectedPlatform: 'mistral', prefix: 'MISTRAL_', isDuplicate: false },
      ]);
      expect(body.total).toBe(3);
      expect(body.duplicates).toBe(0);
    });

    it('imports selected preview rows', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {
        keys: [
          { keyName: 'GROQ_API_KEY', keyValue: 'gsk_test123', platform: 'groq' },
          { keyName: 'MISTRAL_API_KEY', keyValue: 'mist_test456', platform: 'mistral' },
        ],
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ imported: 2, skipped: [], errors: [], total: 2 });

      const { body: keys } = await request(app, 'GET', '/api/keys');
      expect(keys.map((key: any) => key.platform).sort()).toEqual(['groq', 'mistral']);
    });

    it('auto-imports recognized keys from one file and skips unknown providers', async () => {
      const { status, body } = await multipartRequest(app, '/api/keys/import', 'file', [
        { filename: 'keys.env', content: 'GROQ_API_KEY=gsk_test123\nANTHROPIC_API_KEY=sk-ant-test' },
      ]);

      expect(status).toBe(200);
      expect(body.imported).toBe(1);
      expect(body.skipped).toContain('ANTHROPIC_API_KEY');

      const { body: keys } = await request(app, 'GET', '/api/keys');
      expect(keys).toHaveLength(1);
      expect(keys[0].platform).toBe('groq');
    });

    it('rejects unsupported files and malformed JSON uploads', async () => {
      const unsupported = await multipartRequest(app, '/api/keys/preview', 'files', [
        { filename: 'keys.js', content: 'module.exports = {}' },
      ]);
      expect(unsupported.status).toBe(400);
      expect(unsupported.body.error.message).toBe('Unsupported file type');

      const malformed = await multipartRequest(app, '/api/keys/import', 'file', [
        { filename: 'keys.json', content: '{bad json' },
      ]);
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.message).toBe('Invalid JSON format');
    });
  });
});
