// Bundled by scripts/bundle-server.mjs into build/server.mjs (ESM, only
// better-sqlite3 external). This is the ONLY module allowed to touch server
// internals: the db singleton lives inside this bundle, so anything stateful
// (auth bootstrap, getDb) must be exported from here rather than imported
// from server/src by the main bundle (which would get a second, empty copy).
//
// The server sources live in this same repo (../../server). Keep these
// relative imports in sync with the repo-root default in main.ts.
import '../../server/src/env.js';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../../server/src/app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../server/src/db/index.js';
import { restoreProxySettings, flushProxyCache } from '../../server/src/lib/proxy.js';
import { startHealthChecker, checkAllKeys } from '../../server/src/services/health.js';
import { startCatalogSync } from '../../server/src/services/catalog-sync.js';
import { startCooldownProbe } from '../../server/src/services/cooldown-probe.js';
import { startCustomModelSync } from '../../server/src/services/custom-model-sync.js';
import { startBackupScheduler } from '../../server/src/services/backups.js';
import { cleanupExpiredCooldowns } from '../../server/src/services/ratelimit.js';
import { startWakeDetect } from '../../server/src/lib/wake-detect.js';
import { installProcessSafetyNet } from '../../server/src/lib/process-safety-net.js';
import { installLogRedaction } from '../../server/src/lib/log-redaction.js';
import { userCount, createUser, createSession } from '../../server/src/services/auth.js';
import { NodeScheduler } from '../../server/src/lib/scheduler.js';

export { getDb, getUnifiedApiKey };

export interface StartOptions {
  dbPath: string;
  clientDist: string;
  host: string;
  preferredPort: number;
}

export interface ServerHandle {
  server: Server;
  port: number;
}

// This function mirrors the boot sequence of server/src/index.ts — every
// startup step index.ts performs has to be repeated here by hand (#949), and
// __tests__/server-host-boot.test.ts cross-checks this list against the
// index.ts source so the next step added there fails a desktop test instead
// of silently never running (that is exactly how startBackupScheduler was
// missed: the Backups page saved a schedule that never fired).
//
// Deliberately NOT mirrored, because they are env-driven and the packaged app
// inherits no shell environment:
//   restoreDbBackupIfNeeded / startDbBackupPump   (FREEAPI_DB_BACKUP_* only)
//   applyDeclarativeConfigFromEnv, warnOnEnvDrift, warnOnRoutingOverrideDrift
//   generateSetupCode                             (desktop mints its own user)
export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  // After main.ts's installFileLogger (which already wrapped console.*), so
  // the redaction wrapper sits outermost and the tray-revealed log file gets
  // the same credential-stripped lines a terminal would — users paste it into
  // bug reports. This tap is also the ONLY feed of the dashboard's log viewer
  // (#993): without it the Logs page renders near-empty on desktop. Must not
  // run at module scope: main.ts imports this bundle before the file logger
  // is installed, and wrapping in the other order would tee raw secrets to disk.
  installLogRedaction();
  // A late provider socket reset (undici emits with no listener) must down the
  // request, not the whole menu-bar app.
  installProcessSafetyNet();
  // bundle-server.mjs stamps the build identity via esbuild `define`, which
  // rewrites only the exact `process.env.X` member expressions in this bundle.
  // routes/update.ts reads the values through a plain env object reference, so
  // mirror the inlined literals into the real process.env — without this the
  // packaged app's update check resolves {sha: null, installation: 'unknown'}
  // and reports 'unsupported'.
  const buildSha = process.env.FREELLMAPI_COMMIT_SHA;
  const buildInstall = process.env.FREELLMAPI_INSTALL_METHOD;
  if (buildSha && buildInstall) {
    Object.assign(process.env, {
      FREELLMAPI_COMMIT_SHA: buildSha,
      FREELLMAPI_INSTALL_METHOD: buildInstall,
    });
  }
  process.env.CLIENT_DIST = opts.clientDist;
  // #786: the desktop build has no user-set password (the machine user's
  // password is random and never shown), so password re-verification for
  // key reveal / export would lock the user out. Mark the process as the
  // desktop embedder; the server then skips re-auth for those two endpoints,
  // and only for requests arriving over loopback — with LAN access on we bind
  // 0.0.0.0, and a remote viewer must still enter the password.
  process.env.FREEAPI_DESKTOP = '1';
  initDb(opts.dbPath);
  // One sweep at boot, while the DB is quiet — expired cooldown rows are only
  // collected lazily per route and would otherwise accumulate forever.
  const expiredCooldowns = cleanupExpiredCooldowns();
  if (expiredCooldowns > 0) {
    console.log(`[ratelimit] cleared ${expiredCooldowns} expired cooldown${expiredCooldowns === 1 ? '' : 's'}`);
  }
  // #949: the standalone server hydrates its proxy state in index.ts after
  // initDb; this embedder builds the app without index.ts, so without this
  // the URL saved in the settings table is ignored on every restart and the
  // outbound proxy fields appear empty until re-saved.
  restoreProxySettings();
  const app = createApp();
  const { server, port } = await listenWithScan(app, opts.host, opts.preferredPort);
  // Background timers need a Scheduler since the abstraction landed (4cbb571);
  // mirror server/src/index.ts. Without it both calls receive `undefined` and
  // throw "reading 'every'" on the first scheduler.every() during boot.
  const scheduler = new NodeScheduler();
  startHealthChecker(scheduler);
  startCatalogSync(scheduler);
  startCooldownProbe(scheduler);
  startBackupScheduler(scheduler);
  startCustomModelSync(getDb(), scheduler);
  // Post-sleep recovery — the menu-bar app on a laptop is the canonical
  // lid-close case: flush pooled sockets and force-re-probe every key so the
  // first request after wake doesn't ride a dead connection or a pre-sleep
  // key status. Same hook as server/src/index.ts.
  startWakeDetect({
    async onWake(event) {
      const idle = Math.round(event.idleMs / 1000);
      console.log(`[wake] resumed after ~${idle}s (${event.reason}${event.signal ? `:${event.signal}` : ''}) — flushing stale sockets, re-probing keys`);
      flushProxyCache();
      try {
        await checkAllKeys({ force: true });
      } catch (err: any) {
        console.error(`[wake] post-wake key re-probe failed: ${err?.message ?? err}`);
      }
    },
  });
  return { server, port };
}

// The dashboard window authenticates as a hidden machine user. The password
// is random and never shown — sessions are minted directly against the DB.
export function ensureSessionToken(): string {
  if (userCount() === 0) {
    createUser('desktop@localhost', crypto.randomBytes(24).toString('hex'));
  }
  const first = getDb().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  return createSession(first.id);
}

async function listenWithScan(
  app: ReturnType<typeof createApp>,
  host: string,
  start: number,
  attempts = 50,
): Promise<{ server: Server; port: number }> {
  for (let port = start; port < start + attempts; port++) {
    const server = await tryListen(app, host, port);
    if (server) return { server, port };
  }
  throw new Error(`No free port found in ${start}–${start + attempts - 1}`);
}

function tryListen(app: ReturnType<typeof createApp>, host: string, port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = app.listen(port, host);
    server.once('listening', () => resolve(server));
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') resolve(null);
      else resolve(null);
    });
  });
}
