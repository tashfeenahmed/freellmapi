import './env.js';
import { createApp } from './app.js';
import { initDb, getDb, getSetting } from './db/index.js';
import { startHealthChecker, checkAllKeys } from './services/health.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass, flushProxyCache } from './lib/proxy.js';
import { startWakeDetect } from './lib/wake-detect.js';
import { startCatalogSync } from './services/catalog-sync.js';
import { installProcessSafetyNet } from './lib/process-safety-net.js';
import { NodeScheduler } from './lib/scheduler.js';
import { loadConfig } from './lib/config.js';
import { applyDeclarativeConfig, applyDeclarativeConfigFromEnv } from './services/declarative-config.js';
import { createDeclarativeConfigReloader } from './services/declarative-config-reloader.js';
import { restoreDbBackupIfNeeded, startDbBackupPump } from './lib/db-backup.js';
import { userCount } from './services/auth.js';
import { generateSetupCode } from './lib/setup-code.js';
import { warnOnEnvDrift } from './lib/env-drift.js';

async function main() {
  const config = loadConfig();
  const { port: PORT, host: HOST } = config;
  warnOnEnvDrift();

  // Install first so a late provider socket reset (undici HTTP/2 error with no
  // listener) can't take the proxy down. Genuine bugs still exit 1.
  installProcessSafetyNet();

  const scheduler = new NodeScheduler();

  if (config.dbPath) {
    await restoreDbBackupIfNeeded(config.dbPath);
  } else {
    await restoreDbBackupIfNeeded();
  }
  initDb(config.dbPath ?? undefined);
  const declarativeConfigPath = process.env.FREEAPI_CONFIG_PATH?.trim();
  if (declarativeConfigPath) {
    const reloader = createDeclarativeConfigReloader({
      configPath: declarativeConfigPath,
      apply: (value, source) => {
        const result = applyDeclarativeConfig(value, source);
        console.log(
          `[config] applied ${source}: ${result.keys} keys, ${result.customModels} custom models, ` +
          `${result.models} model edits, ${result.fallback} fallback rows${result.routing ? ', routing' : ''}`,
        );
      },
      onError: (error) => console.error(`[config] declarative reload failed: ${error.message}`),
    });
    await reloader.start();
  } else {
    applyDeclarativeConfigFromEnv();
  }

  // First-run hardening: when the dashboard is still unclaimed, mint a one-time
  // setup code and log it. A loopback browser can finish setup without it; a
  // remote caller must supply it (see routes/auth.ts). Regenerated each boot.
  if (userCount() === 0) {
    generateSetupCode();
  }

  // Load the persisted proxy settings from the DB (env var wins if set).
  // Must happen after initDb so the settings table is ready.
  applyProxyUrl(getSetting('proxy_url') ?? '');
  applyProxyEnabled(getSetting('proxy_enabled') !== '0'); // default: enabled
  applyProxyBypass(getSetting('proxy_bypass') ?? '');

  const app = createApp(config);

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker(scheduler);
    startCatalogSync(scheduler);
    startDbBackupPump(getDb(), scheduler, config.dbPath ?? undefined);

    // Post-sleep recovery: while the host was suspended (laptop lid, VM
    // pause) timers and keep-alive sockets froze, so the first requests after
    // wake used to hit dead pooled connections and pre-sleep key statuses
    // until the 5-minute health cycle caught up. On a detected wake (>30s
    // wall-clock drift, or SIGCONT/SIGUSR1/2), drop the proxy dispatcher's
    // pooled sockets and re-probe every key immediately.
    startWakeDetect({
      async onWake(event) {
        const idle = Math.round(event.idleMs / 1000);
        console.log(`[wake] resumed after ~${idle}s (${event.reason}${event.signal ? `:${event.signal}` : ''}) — flushing stale sockets, re-probing keys`);
        flushProxyCache();
        try {
          await checkAllKeys();
        } catch (err: any) {
          console.error(`[wake] post-wake key re-probe failed: ${err?.message ?? err}`);
        }
      },
    });
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
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
