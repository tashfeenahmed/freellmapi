import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import http from 'node:http';
import { createUpdateRouter } from '../../routes/update.js';

const LOCAL_SHA = '0123456789abcdef0123456789abcdef01234567';
const REMOTE_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-07-28T14:00:00.000Z');
const VERSION = '0.6.8';

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
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function atomResponse(commits: Array<{ sha: string; message: string; date?: string }>, status = 200): Response {
  const entries = commits.map(commit => `
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${commit.sha}</id>
    <title>${commit.message}</title>
    ${commit.date ? `<updated>${commit.date}</updated>` : ''}
  </entry>`).join('');
  return new Response(`<?xml version="1.0"?><feed>${entries}</feed>`, {
    status,
    headers: { 'Content-Type': 'application/atom+xml' },
  });
}

function compareBody(status: 'identical' | 'ahead' | 'behind' | 'diverged', message = 'remote commit') {
  const commit = {
    sha: status === 'identical' ? LOCAL_SHA : REMOTE_SHA,
    commit: {
      message,
      committer: { date: '2026-07-28T10:00:00Z' },
    },
  };
  return {
    status,
    commits: status === 'identical' || status === 'behind' ? [] : [commit],
    base_commit: commit,
    merge_base_commit: commit,
  };
}

function createTestApp(overrides: Parameters<typeof createUpdateRouter>[0] = {}) {
  const app = express();
  const fetchMock = overrides.fetch ?? vi.fn(async () => response(compareBody('identical')));
  const execMock = overrides.execFile ?? vi.fn(async () => ({ stdout: `${LOCAL_SHA}\n` }));
  const logger = overrides.logger ?? { error: vi.fn() };
  app.use('/api/update', createUpdateRouter({
    env: {},
    cwd: '/worktree/server',
    now: () => NOW,
    version: () => VERSION,
    ...overrides,
    fetch: fetchMock,
    execFile: execMock,
    logger,
  }));
  return { app, fetchMock, execMock, logger };
}

describe('Update API', () => {
  describe('GET /api/update/check', () => {
    it.each([
      ['identical', 'current'],
      ['ahead', 'available'],
      ['behind', 'ahead'],
      ['diverged', 'diverged'],
    ] as const)('maps GitHub %s to %s', async (githubStatus, expectedStatus) => {
      const fetchMock = vi.fn(async () => response(compareBody(githubStatus)));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: expectedStatus,
        installation: 'source',
        localSha: LOCAL_SHA.slice(0, 7),
        remoteSha: (githubStatus === 'identical' ? LOCAL_SHA : REMOTE_SHA).slice(0, 7),
        remoteMessage: 'remote commit',
        remoteDate: '2026-07-28T10:00:00Z',
        checkedAt: '2026-07-28T14:00:00.000Z',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.github.com/repos/tashfeenahmed/freellmapi/compare/${LOCAL_SHA}...main`,
        expect.any(Object),
      );
    });

    it('prefers a validated packaged-build identity and truncates commit messages', async () => {
      const longMessage = 'x'.repeat(250);
      const fetchMock = vi.fn(async () => response(compareBody('ahead', longMessage)));
      const execMock = vi.fn(async () => ({ stdout: `${REMOTE_SHA}\n` }));
      const { app } = createTestApp({
        env: {
          FREELLMAPI_COMMIT_SHA: LOCAL_SHA.toUpperCase(),
          FREELLMAPI_INSTALL_METHOD: 'docker',
        },
        fetch: fetchMock,
        execFile: execMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.body.installation).toBe('docker');
      expect(result.body.remoteMessage).toHaveLength(200);
      expect(execMock).not.toHaveBeenCalled();
    });

    it('uses an explicitly configured update-check token for authenticated rate limits', async () => {
      const fetchMock = vi.fn(async () => response(compareBody('identical')));
      const { app } = createTestApp({
        env: { FREELLMAPI_UPDATE_GITHUB_TOKEN: 'test-token' },
        fetch: fetchMock,
      });

      await httpGet(app, '/api/update/check');

      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }));
    });

    it('does not borrow an ambient GitHub token', async () => {
      const fetchMock = vi.fn(async () => response(compareBody('identical')));
      const { app } = createTestApp({
        env: { GITHUB_TOKEN: 'ambient-token' },
        fetch: fetchMock,
      });

      await httpGet(app, '/api/update/check');

      const request = fetchMock.mock.calls[0][1];
      expect(request?.headers).not.toHaveProperty('Authorization');
    });

    it('compares desktop installs against the latest release tag, not main', async () => {
      const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
        if (String(url).includes('/releases/latest')) {
          return response({
            tag_name: 'v0.11.0',
            html_url: 'https://github.com/tashfeenahmed/freellmapi/releases/tag/v0.11.0',
          });
        }
        return response(compareBody('identical'));
      });
      const { app } = createTestApp({
        env: { FREELLMAPI_INSTALL_METHOD: 'desktop', FREELLMAPI_COMMIT_SHA: LOCAL_SHA },
        fetch: fetchMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.body).toMatchObject({ status: 'current', installation: 'desktop' });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.github.com/repos/tashfeenahmed/freellmapi/compare/${LOCAL_SHA}...v0.11.0`,
        expect.any(Object),
      );
      // 'identical' against the tag: no update offered for untagged main commits.
      expect(result.body.remoteSha).toBe(LOCAL_SHA.slice(0, 7));
    });

    it('reports an update when a desktop install trails the latest tag', async () => {
      const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
        if (String(url).includes('/releases/latest')) {
          return response({
            tag_name: 'v0.12.0',
            html_url: 'https://github.com/tashfeenahmed/freellmapi/releases/tag/v0.12.0',
          });
        }
        return response(compareBody('ahead'));
      });
      const { app } = createTestApp({
        env: { FREELLMAPI_INSTALL_METHOD: 'desktop', FREELLMAPI_COMMIT_SHA: LOCAL_SHA },
        fetch: fetchMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.body).toMatchObject({ status: 'available', installation: 'desktop' });
    });

    it('reports unknown for a desktop install when no release tag can be resolved', async () => {
      const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
        if (String(url).includes('/releases/latest')) return response({ message: 'no releases' }, 404);
        return response(compareBody('ahead'));
      });
      const { app } = createTestApp({
        env: { FREELLMAPI_INSTALL_METHOD: 'desktop', FREELLMAPI_COMMIT_SHA: LOCAL_SHA },
        fetch: fetchMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.body).toMatchObject({ status: 'unknown', installation: 'desktop' });
      // Without a tag to compare against, main must not be dialed at all.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never falls back to the main-branch Atom feed for a desktop install', async () => {
      const fetchMock = vi.fn(async (url: string | URL | RequestInfo) => {
        if (String(url).includes('/releases/latest')) {
          return response({
            tag_name: 'v0.11.0',
            html_url: 'https://github.com/tashfeenahmed/freellmapi/releases/tag/v0.11.0',
          });
        }
        return response({ message: 'rate limited' }, 403);
      });
      const { app } = createTestApp({
        env: { FREELLMAPI_INSTALL_METHOD: 'desktop', FREELLMAPI_COMMIT_SHA: LOCAL_SHA },
        fetch: fetchMock,
      });

      const result = await httpGet(app, '/api/update/check');

      // The Atom feed only tracks main; falling back to it would re-offer
      // untagged commits, so the request must surface as an upstream error.
      expect(result.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports disabled without resolving Git identity or making a network request', async () => {
      const fetchMock = vi.fn();
      const execMock = vi.fn(async () => ({ stdout: `${LOCAL_SHA}\n` }));
      const { app, logger } = createTestApp({
        env: { FREELLMAPI_UPDATE_CHECK: ' OFF ' },
        fetch: fetchMock,
        execFile: execMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        status: 'disabled',
        installation: 'unknown',
        localSha: null,
        checkedAt: '2026-07-28T14:00:00.000Z',
        version: null,
      });
      expect(execMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('falls back to the public Atom feed when the anonymous API limit is exhausted', async () => {
      const newestSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const middleSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response({ message: 'API rate limit exceeded' }, 403))
        .mockResolvedValueOnce(atomResponse([
          { sha: newestSha, message: 'Newest &amp; safest', date: '2026-07-28T13:00:00Z' },
          { sha: middleSha, message: 'Middle commit', date: '2026-07-28T12:00:00Z' },
          { sha: LOCAL_SHA, message: 'Installed commit', date: '2026-07-28T11:00:00Z' },
        ]));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: 'available',
        remoteSha: newestSha.slice(0, 7),
        remoteMessage: 'Newest & safest',
        remoteDate: '2026-07-28T13:00:00Z',
        changes: [
          { sha: newestSha.slice(0, 7), message: 'Newest & safest', date: '2026-07-28T13:00:00Z' },
          { sha: middleSha.slice(0, 7), message: 'Middle commit', date: '2026-07-28T12:00:00Z' },
        ],
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://github.com/tashfeenahmed/freellmapi/commits/main.atom',
        expect.any(Object),
      );
    });

    it('uses the Atom fallback to recognize the current build', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(undefined, 401))
        .mockResolvedValueOnce(atomResponse([
          { sha: LOCAL_SHA, message: 'Current commit', date: '2026-07-28T13:00:00Z' },
        ]));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body.status).toBe('current');
      expect(result.body.changes).toBeUndefined();
    });

    it('returns at most eight changes in newest-first order with optional dates', async () => {
      const commits = Array.from({ length: 10 }, (_, index) => {
        const number = index + 1;
        return {
          sha: number.toString(16).padStart(40, '0'),
          commit: {
            message: `subject ${number}\nignored body`,
            ...(number === 9 ? {} : { committer: { date: `2026-07-${number.toString().padStart(2, '0')}T10:00:00Z` } }),
          },
        };
      });
      const fetchMock = vi.fn(async () => response({
        ...compareBody('ahead'),
        commits,
      }));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body.changes).toHaveLength(8);
      expect(result.body.changes.map((change: { message: string }) => change.message)).toEqual([
        'subject 10',
        'subject 9',
        'subject 8',
        'subject 7',
        'subject 6',
        'subject 5',
        'subject 4',
        'subject 3',
      ]);
      expect(result.body.changes[0]).toEqual({
        sha: commits[9].sha.slice(0, 7),
        message: 'subject 10',
        date: '2026-07-10T10:00:00Z',
      });
      expect(result.body.changes[1]).toEqual({
        sha: commits[8].sha.slice(0, 7),
        message: 'subject 9',
      });
    });

    it('caps change subjects at 160 characters', async () => {
      const fetchMock = vi.fn(async () => response(compareBody(
        'ahead',
        `${'x'.repeat(200)}\nignored body`,
      )));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body.changes).toEqual([{
        sha: REMOTE_SHA.slice(0, 7),
        message: 'x'.repeat(160),
        date: '2026-07-28T10:00:00Z',
      }]);
    });

    it('rejects malformed commits selected for the changelog', async () => {
      const validCommit = compareBody('ahead').commits[0];
      const fetchMock = vi.fn(async () => response({
        ...compareBody('ahead'),
        commits: [
          { sha: LOCAL_SHA, commit: { message: 42 } },
          validCommit,
        ],
      }));
      const logger = { error: vi.fn() };
      const { app } = createTestApp({ fetch: fetchMock, logger });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(502);
      expect(result.body).toEqual({
        error: { message: 'Unable to check for updates', type: 'upstream_error' },
      });
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('resolves Git identity lazily from the current working directory', async () => {
      const execMock = vi.fn(async () => ({ stdout: `${LOCAL_SHA}\n` }));
      const { app } = createTestApp({
        env: { FREELLMAPI_COMMIT_SHA: 'invalid' },
        execFile: execMock,
      });
      expect(execMock).not.toHaveBeenCalled();

      await httpGet(app, '/api/update/status');

      expect(execMock).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
        cwd: '/worktree/server',
        encoding: 'utf8',
        timeout: 5_000,
      });
    });

    it('returns unknown for an unrecognized commit without parsing the 404 body', async () => {
      const fetchMock = vi.fn(async () => response({ private: 'upstream detail' }, 404));
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        status: 'unknown',
        installation: 'source',
        localSha: LOCAL_SHA.slice(0, 7),
        checkedAt: '2026-07-28T14:00:00.000Z',
        version: VERSION,
      });
    });

    it('returns unsupported without a network request when no identity is available', async () => {
      const fetchMock = vi.fn();
      const execMock = vi.fn(async () => { throw new Error('not a repository'); });
      const { app } = createTestApp({ fetch: fetchMock, execFile: execMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        status: 'unsupported',
        installation: 'unknown',
        localSha: null,
        checkedAt: '2026-07-28T14:00:00.000Z',
        version: VERSION,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('preserves the install method for a self-built Docker image without Git metadata', async () => {
      const fetchMock = vi.fn();
      const execMock = vi.fn(async () => ({ stdout: `${LOCAL_SHA}\n` }));
      const { app } = createTestApp({
        env: { FREELLMAPI_INSTALL_METHOD: 'docker' },
        fetch: fetchMock,
        execFile: execMock,
      });

      const result = await httpGet(app, '/api/update/check');

      expect(result.body).toMatchObject({
        status: 'unsupported',
        installation: 'docker',
        localSha: null,
      });
      expect(execMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['network failure', vi.fn(async () => { throw new Error('secret network detail'); })],
      ['non-2xx response', vi.fn(async () => response({ message: 'upstream detail' }, 500))],
      ['malformed response', vi.fn(async () => response({ status: 'ahead', commits: [{ sha: 'not-a-sha' }] }))],
    ])('returns a stable 502 for %s and logs details', async (_name, fetchMock) => {
      const logger = { error: vi.fn() };
      const { app } = createTestApp({ fetch: fetchMock, logger });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(502);
      expect(result.body).toEqual({
        error: { message: 'Unable to check for updates', type: 'upstream_error' },
      });
      expect(JSON.stringify(result.body)).not.toMatch(/secret|upstream detail|not-a-sha/);
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('caches successful semantic results for five minutes, and failures only briefly', async () => {
      let currentTime = NOW;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(compareBody('ahead')))
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(response(compareBody('identical')));
      const { app } = createTestApp({ fetch: fetchMock, now: () => currentTime });

      expect((await httpGet(app, '/api/update/check')).body.status).toBe('available');
      currentTime += 299_999;
      expect((await httpGet(app, '/api/update/check')).body.status).toBe('available');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      currentTime += 1;
      expect((await httpGet(app, '/api/update/check')).status).toBe(502);
      // A failure is never cached as a result, only suppressed for its short
      // negative TTL — so the retry happens, just not on the very next click.
      currentTime += 45_000;
      expect((await httpGet(app, '/api/update/check')).body.status).toBe('current');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('coalesces concurrent in-flight checks', async () => {
      let resolveFetch!: (value: Response) => void;
      const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
      const { app } = createTestApp({ fetch: fetchMock });

      const first = httpGet(app, '/api/update/check');
      const second = httpGet(app, '/api/update/check');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      resolveFetch(response(compareBody('ahead')));

      expect((await first).body.status).toBe('available');
      expect((await second).body.status).toBe('available');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('GET /api/update/status', () => {
    it('reports disabled without resolving Git identity or making a network request', async () => {
      const fetchMock = vi.fn();
      const execMock = vi.fn(async () => ({ stdout: `${LOCAL_SHA}\n` }));
      const { app } = createTestApp({
        env: { FREELLMAPI_UPDATE_CHECK: 'off' },
        fetch: fetchMock,
        execFile: execMock,
      });

      expect((await httpGet(app, '/api/update/status')).body).toEqual({
        status: 'disabled',
        installation: 'unknown',
        localSha: null,
        lastChecked: null,
        version: null,
      });
      expect(execMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns idle before a supported installation has checked', async () => {
      const { app } = createTestApp();

      expect((await httpGet(app, '/api/update/status')).body).toEqual({
        status: 'idle',
        installation: 'source',
        localSha: LOCAL_SHA.slice(0, 7),
        lastChecked: null,
        version: VERSION,
      });
    });

    it('returns unsupported for an unknown installation', async () => {
      const { app } = createTestApp({ execFile: vi.fn(async () => ({ stdout: 'invalid' })) });

      expect((await httpGet(app, '/api/update/status')).body).toEqual({
        status: 'unsupported',
        installation: 'unknown',
        localSha: null,
        lastChecked: null,
        version: VERSION,
      });
    });

    it('returns the cached semantic state and last checked time without fetching', async () => {
      const fetchMock = vi.fn(async () => response(compareBody('diverged')));
      const { app } = createTestApp({ fetch: fetchMock });
      await httpGet(app, '/api/update/check');

      expect((await httpGet(app, '/api/update/status')).body).toEqual({
        status: 'diverged',
        installation: 'source',
        localSha: LOCAL_SHA.slice(0, 7),
        lastChecked: '2026-07-28T14:00:00.000Z',
        version: VERSION,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('release version', () => {
    it('serves the release version alongside the commit comparison', async () => {
      const { app } = createTestApp();

      const check = await httpGet(app, '/api/update/check');
      const status = await httpGet(app, '/api/update/status');

      expect(check.body.version).toBe(VERSION);
      expect(status.body.version).toBe(VERSION);
    });

    it('reports a null version rather than a number that is not the release', async () => {
      const { app } = createTestApp({ version: () => null });

      expect((await httpGet(app, '/api/update/check')).body.version).toBeNull();
      expect((await httpGet(app, '/api/update/status')).body.version).toBeNull();
    });
  });

  describe('failure caching', () => {
    it('does not re-dial GitHub for every click while a failure is fresh', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('unreachable'); });
      const { app, logger } = createTestApp({ fetch: fetchMock });

      const first = await httpGet(app, '/api/update/check');
      const second = await httpGet(app, '/api/update/check');

      expect(first.status).toBe(502);
      expect(second.status).toBe(502);
      // The second click is answered from the negative cache: one attempt total.
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledOnce();
    });

    it('retries once the negative TTL has elapsed', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('unreachable'))
        .mockResolvedValueOnce(response(compareBody('identical')));
      let clock = NOW;
      const { app } = createTestApp({ fetch: fetchMock, now: () => clock });

      expect((await httpGet(app, '/api/update/check')).status).toBe(502);
      clock = NOW + 46_000;
      const retry = await httpGet(app, '/api/update/check');

      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('current');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('serves a successful result from cache and clears the failure state', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('unreachable'))
        .mockResolvedValueOnce(response(compareBody('ahead')));
      let clock = NOW;
      const { app } = createTestApp({ fetch: fetchMock, now: () => clock });

      await httpGet(app, '/api/update/check');
      clock = NOW + 46_000;
      await httpGet(app, '/api/update/check');
      const cached = await httpGet(app, '/api/update/check');

      expect(cached.status).toBe(200);
      expect(cached.body.status).toBe('available');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Atom feed ceiling', () => {
    it('refuses an oversized feed on the declared length, before reading it', async () => {
      const oversized = new Response('<feed/>', {
        status: 200,
        headers: { 'Content-Type': 'application/atom+xml', 'Content-Length': String(2_000_000) },
      });
      const textSpy = vi.spyOn(oversized, 'text');
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response({ message: 'API rate limit exceeded' }, 403))
        .mockResolvedValueOnce(oversized);
      const { app } = createTestApp({ fetch: fetchMock });

      const result = await httpGet(app, '/api/update/check');

      expect(result.status).toBe(502);
      expect(textSpy).not.toHaveBeenCalled();
    });

    it('refuses a feed that exceeds the ceiling mid-stream', async () => {
      const body = `<?xml version="1.0"?><feed>${'<!-- padding -->'.repeat(70_000)}</feed>`;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response({ message: 'API rate limit exceeded' }, 403))
        .mockResolvedValueOnce(new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/atom+xml' },
        }));
      const { app } = createTestApp({ fetch: fetchMock });

      expect((await httpGet(app, '/api/update/check')).status).toBe(502);
    });
  });
});
