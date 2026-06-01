import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, raw: data };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function addAgnesKey(apiKey = 'agnes_test_key') {
  const { encrypted, iv, authTag } = encrypt(apiKey);
  return getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('agnes', 'test agnes', ?, ?, ?, 'healthy', 1)
  `).run(encrypted, iv, authTag);
}

describe('Agnes media routes', () => {
  let app: Express;
  let origFetch: typeof global.fetch;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    origFetch = global.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires the unified API key for image generation', async () => {
    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'agnes-image-2.0-flash',
      prompt: 'a test image',
    });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('returns a clear routing error when no Agnes key is configured', async () => {
    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'agnes-image-2.0-flash',
      prompt: 'a test image',
    }, authHeaders());

    expect(status).toBe(503);
    expect(body.error.code).toBe('no_agnes_key');
  });

  it('forwards Agnes image generation requests with the configured provider key', async () => {
    addAgnesKey('agnes_real_key');

    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('apihub.agnes-ai.com/v1/images/generations')) {
        capturedUrl = urlStr;
        capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        capturedBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({
            created: 1780280000,
            data: [{ url: 'https://example.test/image.png' }],
          })),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'Agnes-Image-2.0-Flash',
      prompt: 'a red cube',
      size: '1024x1024',
    }, authHeaders());

    expect(status).toBe(200);
    expect(capturedUrl).toBe('https://apihub.agnes-ai.com/v1/images/generations');
    expect(capturedAuth).toBe('Bearer agnes_real_key');
    expect(capturedBody).toMatchObject({
      model: 'agnes-image-2.0-flash',
      prompt: 'a red cube',
      size: '1024x1024',
    });
    expect(body.data[0].url).toBe('https://example.test/image.png');
  });

  it('forwards Agnes video creation and task polling requests', async () => {
    addAgnesKey('agnes_video_key');

    const seen: Array<{ url: string; method: string; auth: string; body?: any }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('apihub.agnes-ai.com/v1/videos')) {
        seen.push({
          url: urlStr,
          method: String(init?.method ?? 'GET'),
          auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(init?.method) === 'POST') {
          return {
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ id: 'video-task-1', status: 'queued' })),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ id: 'video-task-1', status: 'succeeded', video_url: 'https://example.test/video.mp4' })),
        } as any;
      }
      return origFetch(url, init);
    });

    const create = await request(app, 'POST', '/v1/videos', {
      model: 'Agnes-Video-V2.0',
      prompt: 'a short clip',
    }, authHeaders());
    const poll = await request(app, 'GET', '/v1/videos/video-task-1', undefined, authHeaders());

    expect(create.status).toBe(200);
    expect(create.body.id).toBe('video-task-1');
    expect(poll.status).toBe(200);
    expect(poll.body.video_url).toBe('https://example.test/video.mp4');
    expect(seen).toEqual([
      {
        url: 'https://apihub.agnes-ai.com/v1/videos',
        method: 'POST',
        auth: 'Bearer agnes_video_key',
        body: { model: 'agnes-video-v2.0', prompt: 'a short clip' },
      },
      {
        url: 'https://apihub.agnes-ai.com/v1/videos/video-task-1',
        method: 'GET',
        auth: 'Bearer agnes_video_key',
        body: undefined,
      },
    ]);
  });

  it('requires the unified API key for video creation and task polling', async () => {
    const create = await request(app, 'POST', '/v1/videos', {
      model: 'agnes-video-v2.0',
      prompt: 'a short clip',
    });
    const poll = await request(app, 'GET', '/v1/videos/video-task-1');

    expect(create.status).toBe(401);
    expect(create.body.error.type).toBe('authentication_error');
    expect(poll.status).toBe(401);
    expect(poll.body.error.type).toBe('authentication_error');
  });

  it('uses the next Agnes key when the first key cannot be decrypted', async () => {
    const first = addAgnesKey('bad_key');
    addAgnesKey('agnes_second_key');
    getDb().prepare("UPDATE api_keys SET auth_tag = ? WHERE id = ?").run('a'.repeat(32), first.lastInsertRowid);

    let capturedAuth = '';
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('apihub.agnes-ai.com/v1/images/generations')) {
        capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ data: [{ url: 'https://example.test/image.png' }] })),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'agnes-image-2.0-flash',
      prompt: 'a red cube',
    }, authHeaders());
    const firstKey = getDb().prepare('SELECT status, last_checked_at FROM api_keys WHERE id = ?')
      .get(first.lastInsertRowid) as { status: string; last_checked_at: string | null };

    expect(status).toBe(200);
    expect(body.data[0].url).toBe('https://example.test/image.png');
    expect(capturedAuth).toBe('Bearer agnes_second_key');
    expect(firstKey.status).toBe('error');
    expect(firstKey.last_checked_at).toBeTruthy();
  });

  it('uses the next Agnes key after an upstream 429', async () => {
    addAgnesKey('agnes_rate_limited_key');
    addAgnesKey('agnes_second_key');

    const seenAuth: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('apihub.agnes-ai.com/v1/images/generations')) {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
        seenAuth.push(auth);
        if (auth === 'Bearer agnes_rate_limited_key') {
          return {
            ok: false,
            status: 429,
            text: () => Promise.resolve(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } })),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ data: [{ url: 'https://example.test/image.png' }] })),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'agnes-image-2.0-flash',
      prompt: 'a red cube',
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.data[0].url).toBe('https://example.test/image.png');
    expect(seenAuth).toEqual(['Bearer agnes_rate_limited_key', 'Bearer agnes_second_key']);
  });

  it('requires a prompt for Agnes video creation', async () => {
    addAgnesKey();

    const { status, body } = await request(app, 'POST', '/v1/videos', {
      model: 'agnes-video-v2.0',
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('rejects unsupported media models instead of routing them to Agnes', async () => {
    addAgnesKey();

    const { status, body } = await request(app, 'POST', '/v1/images/generations', {
      model: 'other-image-model',
      prompt: 'a test image',
    }, authHeaders());

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });
});
