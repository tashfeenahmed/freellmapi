import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// #949: the desktop embedder boots the server without server/src/index.ts, so
// every startup step index.ts performs has to be repeated here by hand. The
// regression was one missing line — restoreProxySettings() — and no test on
// either side of the repo noticed: the server suite proves the function works,
// but nothing proved this boot path calls it.
//
// So mock the whole server surface and record the boot sequence. Deleting the
// restoreProxySettings() call, or moving it before initDb (no DB to read) or
// after createApp() (the app is built against stale proxy state), fails here.

const calls: string[] = [];

vi.mock('../../../server/src/env.js', () => ({}));

vi.mock('../../../server/src/db/index.js', () => ({
  initDb: vi.fn(() => {
    calls.push('initDb');
  }),
  getDb: vi.fn(),
  getUnifiedApiKey: vi.fn(),
}));

vi.mock('../../../server/src/lib/proxy.js', () => ({
  restoreProxySettings: vi.fn(() => {
    calls.push('restoreProxySettings');
  }),
}));

vi.mock('../../../server/src/app.js', () => ({
  createApp: vi.fn(() => {
    calls.push('createApp');
    return {
      listen: (_port: number, _host: string) => {
        calls.push('listen');
        const server = new EventEmitter();
        setImmediate(() => server.emit('listening'));
        return server;
      },
    };
  }),
}));

vi.mock('../../../server/src/services/health.js', () => ({
  startHealthChecker: vi.fn(() => {
    calls.push('startHealthChecker');
  }),
}));

vi.mock('../../../server/src/services/catalog-sync.js', () => ({
  startCatalogSync: vi.fn(() => {
    calls.push('startCatalogSync');
  }),
}));

vi.mock('../../../server/src/services/auth.js', () => ({
  userCount: vi.fn(() => 1),
  createUser: vi.fn(),
  createSession: vi.fn(() => 'token'),
}));

vi.mock('../../../server/src/lib/scheduler.js', () => ({
  NodeScheduler: class {},
}));

async function boot(): Promise<void> {
  const { startServer } = await import('../server-host.js');
  await startServer({
    dbPath: ':memory:',
    clientDist: '/tmp/client-dist',
    host: '127.0.0.1',
    preferredPort: 45999,
  });
}

beforeEach(() => {
  calls.length = 0;
});

describe('desktop server boot sequence (#949)', () => {
  it('hydrates the saved proxy settings on every start', async () => {
    await boot();
    expect(calls).toContain('restoreProxySettings');
  });

  it('hydrates after initDb — there is no settings table to read before it', async () => {
    await boot();
    expect(calls.indexOf('restoreProxySettings')).toBeGreaterThan(calls.indexOf('initDb'));
  });

  it('hydrates before the app is built and starts listening', async () => {
    await boot();
    const restored = calls.indexOf('restoreProxySettings');
    expect(restored).toBeLessThan(calls.indexOf('createApp'));
    expect(restored).toBeLessThan(calls.indexOf('listen'));
  });

  it('runs the whole startup in the order server/src/index.ts uses', async () => {
    await boot();
    expect(calls).toEqual([
      'initDb',
      'restoreProxySettings',
      'createApp',
      'listen',
      'startHealthChecker',
      'startCatalogSync',
    ]);
  });
});
