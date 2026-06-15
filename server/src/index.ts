import { installLogRedaction } from './lib/redact.js';
installLogRedaction();

import { resolveDbPathEnv } from './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { hardenDatabase } from './db/hardening.js';
import { hasRemoteSecretsStore } from './services/remote-secrets.js';
import { startHealthChecker } from './services/health.js';

const PORT = process.env.PORT ?? 3001;
// Dual-stack ('::') by default so the dashboard is reachable over both IPv4
// and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
// disabled fall back to IPv4-only below; HOST overrides the default outright.
const HOST = process.env.HOST ?? '::';

async function main() {
  const dbPath = resolveDbPathEnv();
  if (process.env.DATABASE_PATH?.trim()) {
    if (process.env.DB_PATH?.trim() && process.env.DB_PATH.trim() !== process.env.DATABASE_PATH.trim()) {
      console.warn('[db] Both DB_PATH and DATABASE_PATH are set; using DB_PATH.');
    } else if (!process.env.DB_PATH?.trim()) {
      console.warn('[db] DATABASE_PATH is deprecated; use DB_PATH. Using DATABASE_PATH for compatibility.');
    }
  }

  // DB_PATH lets production hosts mount SQLite on persistent storage, e.g.
  // Render disk: DB_PATH=/var/data/freeapi.db. DATABASE_PATH is still accepted
  // as a compatibility alias so older env files keep reopening the same DB.
  const db = initDb(dbPath);
  hardenDatabase(db);
  const app = createApp();

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker();
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  if (hasRemoteSecretsStore()) {
    console.log('[db] Remote secret mirror is enabled via DATABASE_URL (Neon/Postgres).');
  } else {
    console.log('[db] Running in SQLite-only mode. Set DATABASE_URL to mirror settings/api keys to Neon/Postgres.');
  }
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
