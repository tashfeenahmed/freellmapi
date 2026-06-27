import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

async function call(app: Express, method: string, path: string, body?: any, token?: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('debug endpoints', () => {
  let app: Express;
  let token = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();

    // Perform setup to get a valid authentication token
    const setup = await call(app, 'POST', '/api/auth/setup', {
      email: 'admin@example.com',
      password: 'supersecret',
    });
    token = setup.body.token;
  });

  it('gates GET /api/debug/media-status and POST /api/debug/seed-media with 401 when unauthenticated', async () => {
    expect((await call(app, 'GET', '/api/debug/media-status')).status).toBe(401);
    expect((await call(app, 'POST', '/api/debug/seed-media')).status).toBe(401);
  });

  it('GET /api/debug/media-status shows initial empty status', async () => {
    const { status, body } = await call(app, 'GET', '/api/debug/media-status', undefined, token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalMediaModels: 0,
      audioModels: 0,
      imageModels: 0,
      transcriptionModels: 0,
      models: [],
    });
  });

  it('POST /api/debug/seed-media inserts Google TTS model', async () => {
    const { status, body } = await call(app, 'POST', '/api/debug/seed-media', undefined, token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      rowsInserted: 1,
      mediaModelsCount: 1,
      audioModelsCount: 1,
    });
  });

  it('POST /api/debug/seed-media is idempotent and returns rowsInserted=0 on second call', async () => {
    const { status, body } = await call(app, 'POST', '/api/debug/seed-media', undefined, token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      rowsInserted: 0,
      mediaModelsCount: 1,
      audioModelsCount: 1,
    });
  });

  it('GET /api/debug/media-status returns correct models list after seeding', async () => {
    const { status, body } = await call(app, 'GET', '/api/debug/media-status', undefined, token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalMediaModels: 1,
      audioModels: 1,
      imageModels: 0,
      transcriptionModels: 0,
    });
    expect(body.models[0]).toMatchObject({
      platform: 'google',
      model_id: 'gemini-2.5-flash-preview-tts',
      display_name: 'Gemini 2.5 Flash TTS',
      modality: 'audio',
      priority: 1,
      enabled: 1,
      quota_label: 'Keyless',
    });
  });
});
