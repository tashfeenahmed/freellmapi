import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  flushProxyCache: vi.fn(),
}));

vi.mock('../../../server/src/lib/log-redaction.js', () => ({
  installLogRedaction: vi.fn(() => {
    calls.push('installLogRedaction');
    return () => undefined;
  }),
}));

vi.mock('../../../server/src/lib/process-safety-net.js', () => ({
  installProcessSafetyNet: vi.fn(() => {
    calls.push('installProcessSafetyNet');
  }),
}));

vi.mock('../../../server/src/services/ratelimit.js', () => ({
  cleanupExpiredCooldowns: vi.fn(() => {
    calls.push('cleanupExpiredCooldowns');
    return 0;
  }),
}));

vi.mock('../../../server/src/services/cooldown-probe.js', () => ({
  startCooldownProbe: vi.fn(() => {
    calls.push('startCooldownProbe');
  }),
}));

vi.mock('../../../server/src/services/backups.js', () => ({
  startBackupScheduler: vi.fn(() => {
    calls.push('startBackupScheduler');
    return () => undefined;
  }),
}));

vi.mock('../../../server/src/services/custom-model-sync.js', () => ({
  startCustomModelSync: vi.fn(() => {
    calls.push('startCustomModelSync');
    return null;
  }),
}));

vi.mock('../../../server/src/lib/wake-detect.js', () => ({
  startWakeDetect: vi.fn(() => {
    calls.push('startWakeDetect');
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
  checkAllKeys: vi.fn(async () => ({})),
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
      'installLogRedaction',
      'installProcessSafetyNet',
      'initDb',
      'cleanupExpiredCooldowns',
      'restoreProxySettings',
      'createApp',
      'listen',
      'startHealthChecker',
      'startCatalogSync',
      'startCooldownProbe',
      'startBackupScheduler',
      'startCustomModelSync',
      'startWakeDetect',
    ]);
  });

  // The literal list above froze an incomplete sequence once already: it was
  // written for #949 with six steps and then green-lit eight later omissions,
  // including startBackupScheduler — the Backups page saved a schedule that
  // never fired. So derive the required steps from the index.ts source instead
  // of trusting anyone to update both places.
  it('mirrors every startup step server/src/index.ts performs (minus the documented env-only skips)', async () => {
    const indexSrc = fs.readFileSync(
      fileURLToPath(new URL('../../../server/src/index.ts', import.meta.url)),
      'utf8',
    );
    const withoutComments = indexSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const steps = new Set(
      [...withoutComments.matchAll(/\b((?:install|start|cleanup|restore)[A-Z]\w*)\(/g)].map((m) => m[1]),
    );
    // Env-gated (FREEAPI_DB_BACKUP_*): a GUI-launched packaged app inherits no
    // shell environment, so these can never activate on desktop.
    const SKIPPED = new Set(['restoreDbBackupIfNeeded', 'startDbBackupPump']);
    // Regex sanity floor — an index.ts restructure must not blank this test.
    expect(steps.size).toBeGreaterThanOrEqual(10);

    await boot();
    for (const step of steps) {
      if (SKIPPED.has(step)) continue;
      expect(
        calls,
        `server/src/index.ts calls ${step}() but the desktop embedder never does — add it to startServer() in server-host.ts`,
      ).toContain(step);
    }
  });
});
