import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import http from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getSetting, setSetting } from '../../db/index.js';
import { createUpdateRouter, UPDATE_CHECK_SETTING } from '../../routes/update.js';
import { mintDashboardToken } from '../helpers/auth.js';

const NOW = Date.parse('2026-08-09T14:00:00.000Z');
const RELEASE_URL = 'https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest';
const RELEASES_PAGE = 'https://github.com/tashfeenahmed/freellmapi/releases';

function httpGet(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test server address'));
      const req = http.request(
        { hostname: '127.0.0.1', port: address.port, path, method: 'GET' },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          });
        },
      );
      req.on('error', (error) => { server.close(); reject(error); });
      req.end();
    });
  });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function releaseBody(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v0.7.0',
    name: 'FreeLLMAPI v0.7.0',
    body: '## What changed\n- Routing fixes',
    html_url: `${RELEASES_PAGE}/tag/v0.7.0`,
    published_at: '2026-08-08T09:30:00Z',
    ...overrides,
  };
}

function createTestApp(overrides: Parameters<typeof createUpdateRouter>[0] = {}) {
  const app = express();
  const fetchMock = overrides.fetch ?? vi.fn(async () => response(releaseBody()));
  const logger = overrides.logger ?? { error: vi.fn(), log: vi.fn() };
  app.use('/api/update', createUpdateRouter({
    env: {},
    cwd: '/worktree/server',
    now: () => NOW,
    version: () => '0.6.9',
    ...overrides,
    fetch: fetchMock,
    logger,
  }));
  return { app, fetchMock, logger };
}

// The automatic reminder is the one place the dashboard would contact GitHub
// without being asked, so both halves of that are pinned here: the request is
// made by the server (the CSP blocks the browser from making it), and it is
// only made once an operator has opted in.
describe('GET /api/update/release', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('is off until an operator opts in, and makes no outbound request', async () => {
    // No autoCheckEnabled override: this is the real settings-table default.
    expect(getSetting(UPDATE_CHECK_SETTING)).toBeUndefined();
    const fetchMock = vi.fn();
    const { app, logger } = createTestApp({ fetch: fetchMock });

    const result = await httpGet(app, '/api/update/release');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ disabled: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns the mapped latest release once enabled', async () => {
    const fetchMock = vi.fn(async () => response(releaseBody()));
    const { app } = createTestApp({ fetch: fetchMock, autoCheckEnabled: () => true });

    const result = await httpGet(app, '/api/update/release');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      tagName: 'v0.7.0',
      body: '## What changed\n- Routing fixes',
      htmlUrl: `${RELEASES_PAGE}/tag/v0.7.0`,
      publishedAt: '2026-08-08T09:30:00Z',
    });
    expect(fetchMock).toHaveBeenCalledWith(RELEASE_URL, expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }),
    }));
  });

  it('serves a second dashboard load from cache instead of calling GitHub again', async () => {
    const fetchMock = vi.fn(async () => response(releaseBody()));
    const { app } = createTestApp({ fetch: fetchMock, autoCheckEnabled: () => true });

    const first = await httpGet(app, '/api/update/release');
    const second = await httpGet(app, '/api/update/release');

    expect(second.body).toEqual(first.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks once the six-hour cache has expired', async () => {
    const fetchMock = vi.fn(async () => response(releaseBody()));
    let clock = NOW;
    const { app } = createTestApp({
      fetch: fetchMock,
      autoCheckEnabled: () => true,
      now: () => clock,
    });

    await httpGet(app, '/api/update/release');
    clock += 6 * 60 * 60 * 1000 - 1;
    await httpGet(app, '/api/update/release');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 2;
    await httpGet(app, '/api/update/release');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a release link that does not point back at this repository', async () => {
    const fetchMock = vi.fn(async () => response(releaseBody({
      html_url: 'https://example.invalid/releases/tag/v0.7.0',
      published_at: 'not a date',
    })));
    const { app } = createTestApp({ fetch: fetchMock, autoCheckEnabled: () => true });

    const result = await httpGet(app, '/api/update/release');

    expect(result.body.htmlUrl).toBe(RELEASES_PAGE);
    expect(result.body.publishedAt).toBeNull();
  });

  it('stays disabled when the deployment kill switch is set, opt-in or not', async () => {
    const fetchMock = vi.fn();
    const { app } = createTestApp({
      env: { FREELLMAPI_UPDATE_CHECK: 'off' },
      fetch: fetchMock,
      autoCheckEnabled: () => true,
    });

    const result = await httpGet(app, '/api/update/release');

    expect(result.body).toEqual({ disabled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an upstream failure rather than an empty release', async () => {
    const fetchMock = vi.fn(async () => response({ message: 'Not Found' }, 404));
    const { app } = createTestApp({ fetch: fetchMock, autoCheckEnabled: () => true });

    const result = await httpGet(app, '/api/update/release');

    expect(result.status).toBe(502);
    expect(result.body.error.type).toBe('upstream_error');
  });
});

// The flag the endpoint above reads, as the dashboard sets it.
describe('/api/settings/update-check', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  afterEach(() => {
    setSetting(UPDATE_CHECK_SETTING, '0');
  });

  async function request(method: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const address = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${address.port}/api/settings/update-check`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null) as any;
    server.close();
    return { status: res.status, body: json };
  }

  it('reports the check as off before anything is configured', async () => {
    const result = await request('GET');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ enabled: false });
  });

  it('stores the opt-in and reads it back', async () => {
    const put = await request('PUT', { enabled: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true });
    expect(getSetting(UPDATE_CHECK_SETTING)).toBe('1');

    const get = await request('GET');
    expect(get.body).toEqual({ enabled: true });
  });

  it('rejects a body that is not a boolean flag', async () => {
    const result = await request('PUT', { enabled: 'yes' });
    expect(result.status).toBe(400);
    expect(getSetting(UPDATE_CHECK_SETTING)).not.toBe('1');
  });
});
