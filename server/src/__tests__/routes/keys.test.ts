import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { createMultipartBody } from '../helpers/multipart.js';

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

  describe('POST /api/keys/import', () => {
    async function multipartRequest(app: Express, filename: string, content: string) {
      const server = app.listen(0);
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}/api/keys/import`;
      const { body, headers } = createMultipartBody({ filename, content });
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });
      const data = await res.json().catch(() => null);
      server.close();
      return { status: res.status, body: data };
    }

    it('imports keys from a valid .env file', async () => {
      const content = 'MISTRAL_API_KEY=test-key-123\nOPENROUTER_API_KEY=sk-or-test';
      const { status, body } = await multipartRequest(app, 'keys.env', content);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        imported: 2,
        skipped: [],
        errors: [],
        total: 2,
      });
      const { body: keys } = await request(app, 'GET', '/api/keys');
      expect(keys).toHaveLength(2);
    });

    it('imports keys from a valid .json file', async () => {
      const content = JSON.stringify({
        MISTRAL_API_KEY: 'test-key-123',
        OPENROUTER_API_KEY: 'sk-or-test',
      });
      const { status, body } = await multipartRequest(app, 'keys.json', content);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        imported: 2,
        total: 2,
      });
    });

    it('returns 400 for .js files (no longer supported)', async () => {
      const content = 'module.exports = { MISTRAL_API_KEY: "test-key-123" };';
      const { status, body } = await multipartRequest(app, 'keys.js', content);
      expect(status).toBe(400);
      expect(body.error.message).toBe('Unsupported file type');
    });

    it('returns 400 for empty file', async () => {
      const { status, body } = await multipartRequest(app, 'empty.env', '');
      expect(status).toBe(400);
      expect(body.error.message).toBe('File contains no data');
    });

    it('returns 400 for unsupported file extension', async () => {
      const { status, body } = await multipartRequest(app, 'keys.js', 'KEY=value');
      expect(status).toBe(400);
      expect(body.error.message).toBe('Unsupported file type');
    });

    it('returns 400 for malformed JSON', async () => {
      const { status } = await multipartRequest(app, 'keys.json', '{bad json');
      expect(status).toBe(400);
    });

    it('returns 200 with 0 imported and skipped entries for unrecognized keys', async () => {
      const content = 'ANTHROPIC_API_KEY=sk-ant-test';
      const { status, body } = await multipartRequest(app, 'keys.env', content);
      expect(status).toBe(200);
      expect(body.imported).toBe(0);
      expect(body.skipped.length).toBeGreaterThanOrEqual(1);
    });

    it('handles mixed valid and unrecognized keys', async () => {
      const content = 'GROQ_API_KEY=gsk-valid\nANTHROPIC_API_KEY=sk-ant-test';
      const { status, body } = await multipartRequest(app, 'keys.env', content);
      expect(status).toBe(200);
      expect(body.imported).toBe(1);
      expect(body.skipped).toHaveLength(1);
    });
  });

  describe('POST /api/keys/preview', () => {
    function createPreviewMultipartBody(files: Array<{ filename: string; content: string }>) {
      const boundary = '----TestBoundaryPreview';
      const parts: Buffer[] = [];

      for (const file of files) {
        const ext = file.filename.split('.').pop()?.toLowerCase();
        let contentType: string;
        if (ext === 'json') contentType = 'application/json';
        else if (ext === 'env' || ext === 'js') contentType = 'text/plain';
        else contentType = 'application/octet-stream';

        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: ${contentType}\r\n` +
          `\r\n`
        ));
        parts.push(Buffer.from(file.content, 'utf-8'));
        parts.push(Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      return {
        body: Buffer.concat(parts),
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      };
    }

    async function previewRequest(app: Express, files: Array<{ filename: string; content: string }>) {
      const server = app.listen(0);
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}/api/keys/preview`;
      const { body, headers } = createPreviewMultipartBody(files);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });
      const data = await res.json().catch(() => null);
      server.close();
      return { status: res.status, body: data };
    }

    it('returns keys for .env file', async () => {
      const content = 'GROQ_API_KEY=gsk_test123\nGOOGLE_API_KEY=AIzaSyTest\n';
      const { status, body } = await previewRequest(app, [{ filename: 'keys.env', content }]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0].keyName).toBe('GROQ_API_KEY');
      expect(body.keys[0].detectedPlatform).toBe('groq');
      expect(body.total).toBe(2);
    });

    it('returns keys for .json file', async () => {
      const content = JSON.stringify({ GROQ_API_KEY: 'gsk_test123', MISTRAL_API_KEY: 'mist_test456' });
      const { status, body } = await previewRequest(app, [{ filename: 'keys.json', content }]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0].keyName).toBe('GROQ_API_KEY');
      expect(body.total).toBe(2);
    });

    it('returns keys for .jsonc file', async () => {
      const content = JSON.stringify({ GROQ_API_KEY: 'gsk_test123' });
      const { status, body } = await previewRequest(app, [{ filename: 'keys.jsonc', content }]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].keyName).toBe('GROQ_API_KEY');
    });

    it('returns keys for .md file', async () => {
      const content = 'MISTRAL_API_KEY=mist_test789\n';
      const { status, body } = await previewRequest(app, [{ filename: 'keys.md', content }]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].keyName).toBe('MISTRAL_API_KEY');
      expect(body.keys[0].detectedPlatform).toBe('mistral');
    });

    it('returns keys for .txt file', async () => {
      const content = 'GROQ_API_KEY=gsk_test123\n';
      const { status, body } = await previewRequest(app, [{ filename: 'keys.txt', content }]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0].keyName).toBe('GROQ_API_KEY');
    });

    it('returns 400 for .js file', async () => {
      const { status, body } = await previewRequest(app, [{ filename: 'keys.js', content: 'KEY=value' }]);
      expect(status).toBe(400);
      expect(body.error.message).toBe('Unsupported file type');
    });

    it('returns 400 for empty file', async () => {
      const { status, body } = await previewRequest(app, [{ filename: 'keys.env', content: '' }]);
      expect(status).toBe(400);
      expect(body.error.message).toBe('File contains no data');
    });

    it('combines keys from multiple files', async () => {
      const { status, body } = await previewRequest(app, [
        { filename: 'keys.env', content: 'GROQ_API_KEY=gsk_test123\n' },
        { filename: 'keys2.env', content: 'MISTRAL_API_KEY=mist_test456\n' },
      ]);
      expect(status).toBe(200);
      expect(body.keys).toHaveLength(2);
      expect(body.total).toBe(2);
      const keyNames = body.keys.map((k: any) => k.keyName).sort();
      expect(keyNames).toEqual(['GROQ_API_KEY', 'MISTRAL_API_KEY']);
    });
  });

  describe('POST /api/keys/import-selected', () => {
    it('imports a single valid key', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {
        keys: [{ keyName: 'GROQ_API_KEY', keyValue: 'gsk_test', platform: 'groq' }],
      });
      expect(status).toBe(200);
      expect(body.imported).toBe(1);
      expect(body.total).toBe(1);
    });

    it('imports multiple keys', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {
        keys: [
          { keyName: 'GROQ_API_KEY', keyValue: 'gsk_test', platform: 'groq' },
          { keyName: 'MISTRAL_API_KEY', keyValue: 'mist_test', platform: 'mistral' },
        ],
      });
      expect(status).toBe(200);
      expect(body.imported).toBe(2);
      expect(body.total).toBe(2);
    });

    it('returns 400 for invalid platform', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {
        keys: [{ keyName: 'X', keyValue: 'y', platform: 'bad_platform' }],
      });
      expect(status).toBe(400);
      expect(body.error.message).toContain('Invalid platform');
    });

    it('returns 200 for empty keys array', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {
        keys: [],
      });
      expect(status).toBe(200);
      expect(body.imported).toBe(0);
      expect(body.total).toBe(0);
    });

    it('returns 400 for missing keys array', async () => {
      const { status, body } = await request(app, 'POST', '/api/keys/import-selected', {});
      expect(status).toBe(400);
    });
  });
  });
});
