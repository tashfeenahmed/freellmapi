import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import http from 'http';

let mockServer: http.Server;
let mockBaseUrl: string;

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

describe('Sync API', () => {
  let app: Express;

  beforeAll(async () => {
    const models = [
      { name: 'llama3.2:3b' },
      { name: 'phi3:3.8b' },
      { name: 'mistral:7b' }
    ];
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models }));
    });
    await new Promise<void>(resolve => mockServer.listen(0, resolve));
    const address = mockServer.address() as any;
    mockBaseUrl = `http://127.0.0.1:${address.port}`;

    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => mockServer.close());

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/sync returns 400 when provider is missing', async () => {
    const { status, body } = await request(app, 'GET', '/api/sync');
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid or missing provider. Use provider=ollama-local to run sync.');
  });

  it('GET /api/sync returns 404 when no providers configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/sync?provider=ollama-local');
    expect(status).toBe(404);
    expect(body.error).toBe('No enabled ollama-local providers configured');
  });

  it('GET /api/sync imports models when provider is ollama-local', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'ollama-local',
      label: 'Test Ollama',
      baseUrl: mockBaseUrl
    });

    const { status, body } = await request(app, 'GET', '/api/sync?provider=ollama-local');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.imported_count).toBeGreaterThan(0);
    expect(body.models).toContain('llama3.2:3b');
    expect(body.models).toContain('phi3:3.8b');
    expect(body.models).toContain('mistral:7b');
  });

  it('GET /api/sync handles invalid provider', async () => {
    const { status, body } = await request(app, 'GET', '/api/sync?provider=nonexistent');
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid or missing provider. Use provider=ollama-local to run sync.');
  });

  it('GET /api/sync is idempotent', async () => {
    await request(app, 'POST', '/api/keys', {
      platform: 'ollama-local',
      label: 'Test Ollama',
      baseUrl: mockBaseUrl
    });

    const initialResult = await request(app, 'GET', '/api/sync?provider=ollama-local');
    const finalResult = await request(app, 'GET', '/api/sync?provider=ollama-local');
    
    expect(initialResult.status).toBe(200);
    expect(finalResult.status).toBe(200);
    expect(initialResult.body.imported_count).toBeGreaterThan(0);
    expect(finalResult.body.imported_count).toBe(0);
  });
});