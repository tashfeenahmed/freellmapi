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

describe('Chats API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM chat_sessions').run();
  });

  it('saves a chat and returns it in history', async () => {
    const { status, body } = await request(app, 'POST', '/api/chats', {
      selectedModel: 'auto',
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: 'Hi there',
          meta: { platform: 'google', model: 'gemini-test', latency: 123, fallbackAttempts: 1 },
        },
      ],
    });

    expect(status).toBe(201);
    expect(body.id).toBeGreaterThan(0);
    expect(body.title).toBe('Hello');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].meta.platform).toBe('google');

    const history = await request(app, 'GET', '/api/chats');
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].messageCount).toBe(2);
  });

  it('updates an existing chat snapshot', async () => {
    const created = await request(app, 'POST', '/api/chats', {
      selectedModel: 'auto',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
      ],
    });

    const updated = await request(app, 'POST', '/api/chats', {
      sessionId: created.body.id,
      selectedModel: 'some-model',
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second' },
      ],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.selectedModel).toBe('some-model');
    expect(updated.body.messages).toHaveLength(3);

    const loaded = await request(app, 'GET', `/api/chats/${created.body.id}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.messages[2].content).toBe('Second');
  });
});
