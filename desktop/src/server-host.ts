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
import { startHealthChecker } from '../../server/src/services/health.js';
import { startCatalogSync } from '../../server/src/services/catalog-sync.js';
import { userCount, createUser, createSession } from '../../server/src/services/auth.js';

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

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  process.env.CLIENT_DIST = opts.clientDist;
  initDb(opts.dbPath);
  const app = createApp();
  const { server, port } = await listenWithScan(app, opts.host, opts.preferredPort);
  startHealthChecker();
  startCatalogSync();
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
