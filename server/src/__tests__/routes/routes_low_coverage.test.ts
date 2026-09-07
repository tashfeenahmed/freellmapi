import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';
let app: Express;

async function request(method: string, path: string, body?: any) {
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

describe('Low-coverage routes: premium, profiles, media, embeddings, settings', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  // --- premium (10.11%) ---
  it('GET /api/premium happy path', async () => {
    const { status, body } = await request('GET', '/api/premium');
    expect(status).toBe(200);
    expect(body).toHaveProperty('hasKey');
  });
  it('POST /api/premium/key error: short key', async () => {
    const { status, body } = await request('POST', '/api/premium/key', { key: 'short' });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
  it('POST /api/premium/key error: empty body', async () => {
    const { status, body } = await request('POST', '/api/premium/key', {});
    expect(status).toBe(400);
  });

  // --- profiles (14.98%) ---
  it('GET /api/profiles happy path', async () => {
    const { status, body } = await request('GET', '/api/profiles');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });
  it('GET /api/profiles/active happy path', async () => {
    const { status, body } = await request('GET', '/api/profiles/active');
    expect(status).toBe(200);
    expect(body).toHaveProperty('activeProfileId');
  });

  // --- media (18.18%) ---
  it('GET /api/media happy path', async () => {
    const { status, body } = await request('GET', '/api/media');
    expect(status).toBe(200);
    expect(body).toHaveProperty('models');
  });
  it('PUT /api/media/:id error: bad id type', async () => {
    const { status, body } = await request('PUT', '/api/media/bad', { enabled: true });
    expect(status).toBe(400);
  });
  it('PUT /api/media/:id error: unknown id', async () => {
    const { status, body } = await request('PUT', '/api/media/99999', { enabled: true });
    expect(status).toBe(404);
  });

  // --- embeddings (19.27%) ---
  it('GET /api/embeddings happy path', async () => {
    const { status, body } = await request('GET', '/api/embeddings');
    expect(status).toBe(200);
    expect(body).toHaveProperty('families');
  });
  it('PUT /api/embeddings error: invalid body', async () => {
    const { status, body } = await request('PUT', '/api/embeddings', { providers: 'not-an-array' });
    expect(status).toBe(400);
  });

  // --- settings (32.4%) ---
  it('GET /api/settings/unify happy path', async () => {
    const { status, body } = await request('GET', '/api/settings/unify');
    expect(status).toBe(200);
    expect(body).toHaveProperty('enabled');
  });
  it('PUT /api/settings/unify happy path', async () => {
    const { status, body } = await request('PUT', '/api/settings/unify', { enabled: false });
    expect(status).toBe(200);
    expect(body).toHaveProperty('enabled');
  });
  it('PUT /api/settings/unify error: bad body', async () => {
    const { status, body } = await request('PUT', '/api/settings/unify', { enabled: 'not-bool' });
    expect(status).toBe(400);
  });
  it('GET /api/settings/fusion happy path', async () => {
    const { status, body } = await request('GET', '/api/settings/fusion');
    expect(status).toBe(200);
    expect(body).toHaveProperty('config');
  });
  it('GET /api/settings/anthropic-map happy path', async () => {
    const { status, body } = await request('GET', '/api/settings/anthropic-map');
    expect(status).toBe(200);
    expect(body).toHaveProperty('map');
  });
  it('GET /api/settings/api-key happy path', async () => {
    const { status, body } = await request('GET', '/api/settings/api-key');
    expect(status).toBe(200);
    expect(body).toHaveProperty('apiKey');
  });
  it('GET /api/settings/proxy happy path', async () => {
    const { status, body } = await request('GET', '/api/settings/proxy');
    expect(status).toBe(200);
    expect(body).toHaveProperty('proxyUrl');
  });
  it('PUT /api/settings/proxy error: bad URL scheme', async () => {
    const { status, body } = await request('PUT', '/api/settings/proxy', { proxyUrl: 'ftp://bad.example.com' });
    expect(status).toBe(400);
  });
  it('PUT /api/settings/proxy happy: partial update', async () => {
    const { status, body } = await request('PUT', '/api/settings/proxy', { enabled: true });
    expect(status).toBe(200);
    expect(body).toHaveProperty('enabled');
  });
});
