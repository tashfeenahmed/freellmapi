import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Ollama Key Requirements', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('should reject missing key for groq platform (requires at least 1 character)', async () => {
    const { status } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
    });
    expect(status).toBe(400);
  });

  it('should accept non-empty key for groq platform', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'my-api-key',
      label: 'Test',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
  });

  it('should accept empty key for ollama-local platform (no API key required)', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'ollama-local',
      label: 'My Local Ollama',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('ollama-local');
    expect(body.maskedKey).toContain('...');
  });

  it('should accept ollama-local with custom baseUrl', async () => {
    const { status, body } = await request(app, 'POST', '/api/keys', {
      platform: 'ollama-local',
      label: 'My Remote Ollama',
      baseUrl: 'http://my-ollama-server:11434/v1',
    });
    expect(status).toBe(201);
    expect(body.platform).toBe('ollama-local');
    expect(body.baseUrl).toBe('http://my-ollama-server:11434/v1');
  });
});