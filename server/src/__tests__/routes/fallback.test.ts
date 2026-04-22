import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createTestUserSession, httpJson, setTestSessionPasswordEnv } from '../test-auth-helpers.js';

describe('Fallback API', () => {
  let app: Express;
  let sessionCookie: string;

  beforeAll(async () => {
    setTestSessionPasswordEnv();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    sessionCookie = await createTestUserSession(app);
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBeGreaterThan(0);
    const arr = body as { priority: number }[];
    for (let i = 1; i < arr.length; i++) {
      expect(arr[i].priority).toBeGreaterThanOrEqual(arr[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    const b = body as any[];
    const first = b[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
  });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    const orig = original as any[];

    const reversed = orig.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: orig.length - i,
      enabled: e.enabled,
    }));

    const { status } = await httpJson(app, 'PUT', '/api/fallback', reversed, sessionCookie);
    expect(status).toBe(200);

    const { body: after } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    const a = after as any[];
    expect(a[0].modelDbId).toBe(orig[orig.length - 1].modelDbId);

    const restore = orig.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await httpJson(app, 'PUT', '/api/fallback', restore, sessionCookie);
  });

  it('POST /api/fallback/sort/intelligence sorts by intelligence', async () => {
    const { status } = await httpJson(
      app,
      'POST',
      '/api/fallback/sort/intelligence',
      undefined,
      sessionCookie,
    );
    expect(status).toBe(200);

    const { body } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    const b = body as { intelligenceRank: number }[];
    for (let i = 1; i < b.length; i++) {
      expect(b[i].intelligenceRank).toBeGreaterThanOrEqual(b[i - 1].intelligenceRank);
    }
  });

  it('POST /api/fallback/sort/speed sorts by speed', async () => {
    const { status } = await httpJson(
      app,
      'POST',
      '/api/fallback/sort/speed',
      undefined,
      sessionCookie,
    );
    expect(status).toBe(200);

    const { body } = await httpJson(app, 'GET', '/api/fallback', undefined, sessionCookie);
    const b = body as { speedRank: number }[];
    for (let i = 1; i < b.length; i++) {
      expect(b[i].speedRank).toBeGreaterThanOrEqual(b[i - 1].speedRank);
    }
  });

  it('POST /api/fallback/sort/invalid returns 400', async () => {
    const { status } = await httpJson(
      app,
      'POST',
      '/api/fallback/sort/invalid',
      undefined,
      sessionCookie,
    );
    expect(status).toBe(400);
  });
});
