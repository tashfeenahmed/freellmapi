// Run the bundled gateway under its host Node ABI and the production dashboard,
// preload and IPC in Electron. All credentials, configuration and agent
// executable fixtures belong to a temporary user, including on Windows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import electron from 'electron';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-agent-test-'));
const bin = path.join(home, 'agent bin');
const dot = path.join(home, 'appdata');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: dot, LOCALAPPDATA: dot,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
  PATH: bin + path.delimiter + process.env.PATH, AGENT_TEST_HOME: home,
};
for (const key of ['DSH_HOME', 'GOOSE_PATH_ROOT', 'MIMOCODE_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME',
  'OPENCLAW_CONFIG_PATH', 'HERMES_HOME', 'PI_CODING_AGENT_DIR', 'REASONIX_HOME', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE',
  'ELECTRON_RUN_AS_NODE']) delete env[key];
// Windows environments are case-insensitive; do not leave a second Path for
// libuv to select before the isolated fixtures.
for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
let exitCode = 1;
let db;
// Use the shipped seed catalog throughout the idempotence checks.
process.env.CATALOG_SYNC_DISABLED = '1';
try {
  fs.mkdirSync(bin);
  fs.mkdirSync(dot);
  const { startServer, ensureSessionToken, getUnifiedApiKey, getDb } = await import('../build/server.mjs');
  const { server } = await startServer({ host: '127.0.0.1', preferredPort: 0,
    dbPath: path.join(home, 'gateway.db'), clientDist: path.resolve(desktop, '../client/dist') });
  db = getDb();
  const { port } = server.address();
  const origin = 'http://127.0.0.1:' + port;
  const key = getUnifiedApiKey();
  // A launched fixture must actually authenticate to the running gateway.
  const probe = path.join(home, 'probe.cjs');
  fs.writeFileSync(probe, `(async () => { const r = await fetch(${JSON.stringify(origin + '/v1/models')},
    { headers: { Authorization: 'Bearer ' + process.env.FREELLMAPI_API_KEY } });
    require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(home)}, process.argv[2] + '.result'), String(r.status));
  })().catch(() => process.exit(1));`);
  const fixture = (id) => process.platform === 'win32'
    ? ['@echo off', '"' + process.execPath + '" "' + probe + '" ' + id, 'exit %ERRORLEVEL%', ''].join('\r\n')
    : ['#!/bin/sh', 'exec ' + [process.execPath, probe, id].map(s => "'" + s.replaceAll("'", "'\\''") + "'").join(' '), ''].join('\n');
  for (const id of ['codex', 'goose', 'kilo', 'crush', 'mimo']) {
    fs.writeFileSync(path.join(bin, id + (process.platform === 'win32' ? '.cmd' : '')), fixture(id), { mode: 0o700 });
  }
  const harness = path.join(home, 'agent-setup-smoke.mjs');
  await build({ entryPoints: [path.join(desktop, 'scripts/agent-setup-smoke.ts')], outfile: harness,
    bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, external: ['electron'] });
  const child = spawn(electron, [harness], { stdio: 'inherit',
    env: { ...env, AGENT_TEST_PORT: String(port), AGENT_TEST_PRELOAD: path.join(desktop, 'build/preload.cjs'), AGENT_TEST_TOKEN: ensureSessionToken(), AGENT_TEST_KEY: key } });
  const timer = setTimeout(() => child.kill(), 150_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, 'Electron agent setup smoke failed');
  } finally { clearTimeout(timer); }
  exitCode = 0;
} catch (error) {
  console.error(error);
} finally {
  db?.close();
  // A Windows console or Chromium utility process can release its working
  // directory shortly after the owning process exits. Retry the whole removal
  // asynchronously, including EBUSY on the directory itself (Node 20's
  // synchronous rimraf retries only ENOTEMPTY/EPERM at that point).
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rm(home, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt >= 60 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(500);
    }
  }
  // The embedded server starts its normal long-lived background schedulers.
  process.exit(exitCode);
}
