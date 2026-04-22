import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createTestUserSession, httpJson, setTestSessionPasswordEnv } from '../test-auth-helpers.js';

describe('Keys API', () => {
  let app: Express;
  let sessionCookie: string;

  beforeAll(async () => {
    setTestSessionPasswordEnv();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    sessionCookie = await createTestUserSession(app);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('GET /api/keys returns empty array initially', async () => {
    const { status, body } = await httpJson(app, 'GET', '/api/keys', undefined, sessionCookie);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('POST /api/keys creates a new key', async () => {
    const { status, body } = await httpJson(
      app,
      'POST',
      '/api/keys',
      {
        platform: 'groq',
        key: 'gsk_test123456789',
        label: 'My Groq Key',
      },
      sessionCookie,
    );

    expect(status).toBe(201);
    expect(body.platform).toBe('groq');
    expect(body.label).toBe('My Groq Key');
    expect(body.maskedKey).toContain('...');
  });

  it('GET /api/keys returns the created key', async () => {
    // First create a key
    await httpJson(
      app,
      'POST',
      '/api/keys',
      {
        platform: 'groq',
        key: 'gsk_test123456789',
      },
      sessionCookie,
    );

    const { status, body } = await httpJson(app, 'GET', '/api/keys', undefined, sessionCookie);
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe('groq');
  });

  it('POST /api/keys rejects invalid platform', async () => {
    const { status } = await httpJson(
      app,
      'POST',
      '/api/keys',
      {
        platform: 'invalid_platform',
        key: 'test',
      },
      sessionCookie,
    );
    expect(status).toBe(400);
  });

  it('POST /api/keys rejects missing key', async () => {
    const { status } = await httpJson(app, 'POST', '/api/keys', { platform: 'groq' }, sessionCookie);
    expect(status).toBe(400);
  });

  it('DELETE /api/keys/:id removes a key', async () => {
    const { body: created } = await httpJson(
      app,
      'POST',
      '/api/keys',
      {
        platform: 'groq',
        key: 'gsk_test123456789',
      },
      sessionCookie,
    );

    const { status } = await httpJson(
      app,
      'DELETE',
      `/api/keys/${(created as { id: number }).id}`,
      undefined,
      sessionCookie,
    );
    expect(status).toBe(200);

    const { body: after } = await httpJson(app, 'GET', '/api/keys', undefined, sessionCookie);
    expect(after).toHaveLength(0);
  });

  it('DELETE /api/keys/:id returns 404 for nonexistent key', async () => {
    const { status } = await httpJson(app, 'DELETE', '/api/keys/99999', undefined, sessionCookie);
    expect(status).toBe(404);
  });
});
