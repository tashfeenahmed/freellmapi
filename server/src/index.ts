import './env.js';
import { createApp } from './app.js';
import { getDb, initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { startRateLimitPersistence } from './services/ratelimit.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  initDb();
  const app = createApp();

  // Restore RPD/TPD counters + active cooldowns from SQLite, and start the
  // periodic flush. Returns a stop fn that does a final flush.
  const stopRateLimitPersistence = startRateLimitPersistence(getDb());

  const server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });

  // Graceful shutdown — flush rate-limit state to SQLite before exiting so
  // a restart picks up where we left off. Idempotent against double-signals.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down…`);
    stopRateLimitPersistence();
    server.close(() => process.exit(0));
    // Hard exit if the HTTP server doesn't close within 5s (e.g. lingering keep-alive).
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(console.error);
