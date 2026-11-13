import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Mock only routeRequest so the injection tests don't need real provider keys;
// the rest of the router module stays intact (same approach as responses.test.ts).
const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

// Records the messages each dispatched request carried, so the injection tests
// can assert the exact system-message ordering the provider would see.
const seenMessages: any[][] = [];
function fakeRoute() {
  return {
    provider: {
      name: 'fake',
      async chatCompletion(_apiKey: string, messages: any[]) {
        seenMessages.push(messages);
        return {
          id: 'c', object: 'chat.completion', created: 0, model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        };
      },
    },
    modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model',
  };
}

describe('client profiles (#411)', () => {
  let app: Express;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
    dashToken = mintDashboardToken('client-profiles@example.com');
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    mockRouteRequest.mockImplementation(() => fakeRoute());
    seenMessages.length = 0;
  });

  async function createProfile(name: string, systemPrompt?: string | null) {
    const { status, body } = await request(app, 'POST', '/api/client-profiles', {
      token: dashToken, body: { name, systemPrompt },
    });
    expect(status).toBe(201);
    return body;
  }

  describe('CRUD', () => {
    it('creates a profile and returns the sk-cp key exactly once', async () => {
      const created = await createProfile('crud-bot', 'be helpful');
      expect(created.key).toMatch(/^sk-cp-[0-9a-f]{48}$/);
      expect(created.name).toBe('crud-bot');
      expect(created.systemPrompt).toBe('be helpful');
      expect(created.enabled).toBe(true);
      // Masked display comes from the encrypted copy, never the hash.
      expect(created.maskedKey).toBe(`${created.key.slice(0, 4)}...${created.key.slice(-4)}`);

      const list = await request(app, 'GET', '/api/client-profiles', { token: dashToken });
      expect(list.status).toBe(200);
      const row = list.body.find((p: any) => p.id === created.id);
      expect(row.maskedKey).toBe(created.maskedKey);
      // The full key never appears in the list.
      expect(JSON.stringify(list.body)).not.toContain(created.key);
    });

    it('rejects a create without a name', async () => {
      const { status } = await request(app, 'POST', '/api/client-profiles', {
        token: dashToken, body: { systemPrompt: 'no name' },
      });
      expect(status).toBe(400);
    });

    it('edits name/prompt, clears the prompt with null, and toggles enabled', async () => {
      const created = await createProfile('edit-bot', 'v1');
      const renamed = await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
        token: dashToken, body: { name: 'edit-bot-2', systemPrompt: 'v2' },
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('edit-bot-2');
      expect(renamed.body.systemPrompt).toBe('v2');

      const cleared = await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
        token: dashToken, body: { systemPrompt: null, enabled: false },
      });
      expect(cleared.body.systemPrompt).toBeNull();
      expect(cleared.body.enabled).toBe(false);
      // Fields absent from the patch stay untouched.
      expect(cleared.body.name).toBe('edit-bot-2');
    });

    it('rotate invalidates the old key and returns the new one once', async () => {
      const created = await createProfile('rotate-bot', 'stay on topic');
      const rotated = await request(app, 'POST', `/api/client-profiles/${created.id}/rotate`, { token: dashToken });
      expect(rotated.status).toBe(200);
      expect(rotated.body.key).toMatch(/^sk-cp-[0-9a-f]{48}$/);
      expect(rotated.body.key).not.toBe(created.key);

      const oldKey = await request(app, 'POST', '/v1/chat/completions', {
        token: created.key, body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(oldKey.status).toBe(401);
      const newKey = await request(app, 'POST', '/v1/chat/completions', {
        token: rotated.body.key, body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(newKey.status).toBe(200);
    });

    it('deletes a profile and 404s on unknown ids', async () => {
      const created = await createProfile('delete-bot');
      const del = await request(app, 'DELETE', `/api/client-profiles/${created.id}`, { token: dashToken });
      expect(del.status).toBe(200);
      expect((await request(app, 'DELETE', `/api/client-profiles/${created.id}`, { token: dashToken })).status).toBe(404);
      const auth = await request(app, 'POST', '/v1/chat/completions', {
        token: created.key, body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(auth.status).toBe(401);
    });
  });

  describe('security boundary', () => {
    it('a profile key does NOT authenticate the admin/dashboard API', async () => {
      const created = await createProfile('boundary-bot', 'x');
      for (const [method, path] of [
        ['GET', '/api/client-profiles'],
        ['GET', '/api/keys'],
        ['GET', '/api/settings/api-key'],
      ] as const) {
        const { status } = await request(app, method, path, { token: created.key });
        expect(status, `${method} ${path}`).toBe(401);
      }
    });

    it('the unified key does not authenticate the admin API either (unchanged)', async () => {
      expect((await request(app, 'GET', '/api/client-profiles', { token: unifiedKey })).status).toBe(401);
    });

    it('a disabled profile key is rejected on inference like a bad key', async () => {
      const created = await createProfile('disabled-bot', 'x');
      await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
        token: dashToken, body: { enabled: false },
      });
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        token: created.key, body: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(status).toBe(401);
    });
  });

  describe('server-side prompt injection', () => {
    const callerBody = {
      messages: [
        { role: 'system', content: 'caller instructions' },
        { role: 'user', content: 'hi' },
      ],
    };

    it('prepends the profile prompt on /v1/chat/completions, enforced prompt first', async () => {
      const created = await createProfile('inject-bot', 'ENFORCED PROMPT');
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        token: created.key, body: callerBody,
      });
      expect(status).toBe(200);
      const sent = seenMessages[0];
      // Ordering contract: the enforced prompt is FIRST; the caller-supplied
      // system message survives, after it.
      expect(sent[0]).toMatchObject({ role: 'system', content: 'ENFORCED PROMPT' });
      expect(sent[1]).toMatchObject({ role: 'system', content: 'caller instructions' });
      expect(sent[2]).toMatchObject({ role: 'user', content: 'hi' });
    });

    it('the unified key injects nothing (backward compatible)', async () => {
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        token: unifiedKey, body: callerBody,
      });
      expect(status).toBe(200);
      expect(seenMessages[0][0]).toMatchObject({ role: 'system', content: 'caller instructions' });
      expect(seenMessages[0]).toHaveLength(2);
    });

    it('a profile without a prompt is a neutral passthrough', async () => {
      const created = await createProfile('plain-bot');
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        token: created.key, body: callerBody,
      });
      expect(status).toBe(200);
      expect(seenMessages[0][0]).toMatchObject({ role: 'system', content: 'caller instructions' });
      expect(seenMessages[0]).toHaveLength(2);
    });

    it('prepends the profile prompt on /v1/responses too', async () => {
      const created = await createProfile('responses-bot', 'ENFORCED PROMPT');
      const { status } = await request(app, 'POST', '/v1/responses', {
        token: created.key,
        body: { instructions: 'caller instructions', input: 'hi' },
      });
      expect(status).toBe(200);
      const sent = seenMessages[0];
      expect(sent[0]).toMatchObject({ role: 'system', content: 'ENFORCED PROMPT' });
      expect(sent[1]).toMatchObject({ role: 'system', content: 'caller instructions' });
    });
  });

  describe('the Anthropic surface (/v1/messages) honors profile keys', () => {
    const anthropicBody = {
      model: 'auto',
      max_tokens: 64,
      system: 'caller instructions',
      messages: [{ role: 'user', content: 'hi' }],
    };

    it('accepts a profile key on x-api-key and injects the enforced prompt first', async () => {
      const created = await createProfile('anthropic-bot', 'ENFORCED PROMPT');
      const { status } = await request(app, 'POST', '/v1/messages', {
        token: created.key, body: anthropicBody,
      });
      expect(status).toBe(200);
      const sent = seenMessages[0];
      // Same ordering contract as /v1/chat/completions: enforced first, the
      // caller's system turn survives after it.
      expect(sent[0]).toMatchObject({ role: 'system', content: 'ENFORCED PROMPT' });
      expect(sent.some(m => m.role === 'system' && m.content === 'caller instructions')).toBe(true);
    });

    it('the unified key injects nothing on /v1/messages', async () => {
      const { status } = await request(app, 'POST', '/v1/messages', {
        token: unifiedKey, body: anthropicBody,
      });
      expect(status).toBe(200);
      expect(seenMessages[0][0]).toMatchObject({ role: 'system', content: 'caller instructions' });
    });

    it('a disabled profile key gets 401 on /v1/messages too', async () => {
      const created = await createProfile('anthropic-off', 'x');
      await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
        token: dashToken, body: { enabled: false },
      });
      const { status } = await request(app, 'POST', '/v1/messages', {
        token: created.key, body: anthropicBody,
      });
      expect(status).toBe(401);
    });
  });

  describe('the Gemini surface (/v1beta) honors profile keys', () => {
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'caller instructions' }] },
    };
    const geminiPath = '/v1beta/models/gemini-2.5-flash:generateContent';

    it('accepts a profile key and injects the enforced prompt first', async () => {
      const created = await createProfile('gemini-bot', 'ENFORCED PROMPT');
      const { status } = await request(app, 'POST', geminiPath, {
        token: created.key, body: geminiBody,
      });
      expect(status).toBe(200);
      const sent = seenMessages[0];
      expect(sent[0]).toMatchObject({ role: 'system', content: 'ENFORCED PROMPT' });
      expect(sent.some(m => m.role === 'system' && m.content === 'caller instructions')).toBe(true);
    });

    it('a disabled profile key gets 401 on /v1beta too', async () => {
      const created = await createProfile('gemini-off', 'x');
      await request(app, 'PATCH', `/api/client-profiles/${created.id}`, {
        token: dashToken, body: { enabled: false },
      });
      const { status } = await request(app, 'POST', geminiPath, {
        token: created.key, body: geminiBody,
      });
      expect(status).toBe(401);
    });
  });
});
