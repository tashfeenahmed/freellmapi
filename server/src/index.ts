import './env.js';
import type { Server } from 'http';
import { createApp } from './app.js';
import { initDb, closePostgresPool } from './db/index.js';
import { initRoutingRegistry, stopRoutingRegistryScheduler } from './services/router-registry.js';
import { analyticsAggregator } from './services/analytics-aggregator.js';
import { startHealthChecker, stopHealthChecker } from './services/health.js';
import { startCatalogSync, stopCatalogSync } from './services/catalog-sync.js';
import { NodeScheduler } from './lib/scheduler.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { loadConfig } from './lib/config.js';
import { userCount } from './services/auth.js';
import { generateSetupCode } from './lib/setup-code.js';
import { installLogRedaction } from './lib/log-redaction.js';

// Prevent sensitive provider API keys from leaking to logs/stdout
installLogRedaction();

let server: Server | null = null;
let isShuttingDown = false;

async function main() {
  const config = loadConfig();
  const { port: PORT, host: HOST } = config;

  installProcessSafetyNet();

  console.log('[startup] 1/6 Initializing Neon PostgreSQL pool & running migrations...');
  await initDb();

  console.log('[startup] 2/6 Building in-memory routing registry...');
  await initRoutingRegistry();

  console.log('[startup] 3/6 Starting memory-first analytics aggregator...');
  analyticsAggregator.start();

  console.log('[startup] 3b/6 Starting credential health checker...');
  const scheduler = new NodeScheduler();
  startHealthChecker(scheduler);

  console.log('[startup] 3c/6 Starting catalog sync scheduler...');
  startCatalogSync(scheduler);

  console.log('[startup] 4/6 Checking admin account status...');
  const count = await userCount();
  if (count === 0) {
    generateSetupCode();
  }

  console.log('[startup] 5/6 Creating Express application...');
  const app = createApp(config);

  const tuneKeepAlive = (s: Server) => {
    s.keepAliveTimeout = 75_000;
    s.headersTimeout = 76_000;
  };

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`\n======================================================`);
    console.log(` FreeLLMAPI Server running on http://${display}:${PORT}`);
    console.log(` OpenAI-Compatible API: http://${display}:${PORT}/v1/chat/completions`);
    console.log(` Neon PostgreSQL: Connected (Control Plane)`);
    console.log(` Render In-Memory: Active (Data Plane)`);
    console.log(`======================================================\n`);
  };

  console.log('[startup] 6/6 Starting HTTP listener...');
  server = app.listen(Number(PORT), HOST, onReady(HOST));
  tuneKeepAlive(server);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      server = app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      tuneKeepAlive(server);
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
}

// Graceful shutdown
async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}. Starting graceful shutdown...`);

  const forceExitTimer = setTimeout(() => {
    console.error('[shutdown] Graceful shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10000);

  if (forceExitTimer.unref) {
    forceExitTimer.unref();
  }

  try {
    // 1. Stop accepting new HTTP requests
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => {
          console.log('[shutdown] HTTP server closed.');
          resolve();
        });
      });
    }

    // 2. Stop in-memory registry scheduler
    stopRoutingRegistryScheduler();
    stopHealthChecker();
    stopCatalogSync();

    // 3. Flush pending analytics buffer to Neon PostgreSQL
    console.log('[shutdown] Flushing pending in-memory telemetry to PostgreSQL...');
    await analyticsAggregator.flush();
    analyticsAggregator.stop();

    // 4. Close database connection pool
    console.log('[shutdown] Closing PostgreSQL connection pool...');
    await closePostgresPool();

    console.log('[shutdown] Clean shutdown complete.');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (err: any) {
    console.error('[shutdown] Error during graceful shutdown:', err?.message || err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main().catch((err) => {
  console.error('\n[server] Fatal startup failure:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
