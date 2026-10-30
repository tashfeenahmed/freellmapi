// Integration tests for freellmapi-start.sh. They start the real built server
// on a throwaway port with a throwaway data dir, so they only run where
// node_modules and the build already exist (a prepared cloud session) and are
// skipped elsewhere. Only --check and --stop are exercised: the default mode
// may run `npm ci`, which the tests must never trigger.
//
//   node --test .claude/hooks/freellmapi-start.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const script = path.join(here, 'freellmapi-start.sh');
const ready = process.platform === 'linux'
  && fs.existsSync(path.join(repo, 'node_modules'))
  && fs.existsSync(path.join(repo, 'server/dist/index.js'))
  && fs.existsSync(path.join(repo, 'client/dist/index.html'));
const skip = ready ? false : 'needs node_modules and a built server (run inside a prepared cloud session)';

const SECRET_PW = 'pw-' + crypto.randomBytes(12).toString('hex');
const SECRET_PROVIDER_KEY = 'gsk_' + crypto.randomBytes(12).toString('hex');
const config = (extra = {}) => JSON.stringify({ admin: { email: 'admin@freellmapi.local', password: SECRET_PW }, ...extra });

const roots = [];
let sandbox;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-hook-test-'));
  roots.push(root);
  const s = {
    root,
    port: await freePort(),
    dataDir: path.join(root, 'data'),
    secretsDir: path.join(root, 'secrets'),
    envFile: path.join(root, 'claude-env'),
    key: crypto.randomBytes(32).toString('hex'),
  };
  fs.writeFileSync(s.envFile, '');
  return s;
}

function envFor(s, overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(FREEAPI_|FREELLMAPI_)/.test(name) || ['ENCRYPTION_KEY', 'HOST', 'PORT', 'CLAUDE_ENV_FILE'].includes(name)) delete env[name];
  }
  return {
    ...env,
    CLAUDE_CODE_REMOTE: 'true',
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_ENV_FILE: s.envFile,
    FREELLMAPI_PORT: String(s.port),
    FREELLMAPI_DATA_DIR: s.dataDir,
    FREELLMAPI_SECRETS_DIR: s.secretsDir,
    ENCRYPTION_KEY: s.key,
    FREEAPI_CONFIG_JSON: config(),
    ...overrides,
  };
}

function run(s, args = ['--check'], overrides = {}) {
  const r = spawnSync('bash', [script, ...args], { env: envFor(s, overrides), encoding: 'utf8', timeout: 180_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runAsync(s, args = ['--check']) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], { env: envFor(s), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function serverPids(s) {
  const marker = `FREELLMAPI_MANAGED_DIR=${fs.realpathSync(s.dataDir)}`;
  return fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim() === 'node'
        && fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(marker);
    } catch { return false; }
  }).map(Number);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pid) { for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); }
const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8);

async function ping(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/ping`)).status; } catch { return 0; }
}

function listeners(port) {
  const hex = ':' + port.toString(16).toUpperCase().padStart(4, '0');
  return ['/proc/net/tcp', '/proc/net/tcp6'].filter((f) => fs.existsSync(f))
    .flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').slice(1))
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[3] === '0A' && cols[1].endsWith(hex))
    .map((cols) => cols[1]);
}

before(async () => { if (ready) sandbox = await makeSandbox(); });
after(() => {
  // Stop every sandbox's server before deleting any sandbox: --stop recreates
  // the secrets dir it is pointed at.
  for (const root of roots) {
    const dataDir = path.join(root, 'data');
    const secretsDir = path.join(root, 'secrets');
    if (fs.existsSync(dataDir)) spawnSync('bash', [script, '--stop'], { env: envFor({ ...sandbox, dataDir, secretsDir }), encoding: 'utf8' });
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('starts once, reuses it on repeat, stays on loopback, keeps files private', { skip }, async () => {
  const first = run(sandbox);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, '', 'nothing on stdout: UserPromptSubmit stdout becomes model context');
  const pids = serverPids(sandbox);
  assert.equal(pids.length, 1);
  assert.equal(await ping(sandbox.port), 200);

  for (let i = 0; i < 2; i++) {
    const again = run(sandbox);
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /starting on/);
  }
  assert.deepEqual(serverPids(sandbox), pids, 'no duplicate server');

  const bound = listeners(sandbox.port);
  assert.ok(bound.length > 0);
  for (const addr of bound) assert.match(addr, /^0100007F:/, 'listens on 127.0.0.1 only');

  assert.equal(mode(path.join(sandbox.dataDir, 'server.log')), '600');
  assert.equal(mode(path.join(sandbox.dataDir, 'server.pid')), '600');
  assert.equal(mode(path.join(sandbox.secretsDir, 'unified-key')), '600');
  const envLines = fs.readFileSync(sandbox.envFile, 'utf8').trim().split('\n');
  assert.equal(envLines.length, new Set(envLines).size, 'no duplicate env entries');
  assert.ok(envLines.every((l) => !l.includes('ANTHROPIC_')));
});

test('two overlapping runs start a single server', { skip }, async () => {
  const s = await makeSandbox();
  const [a, b] = await Promise.all([runAsync(s), runAsync(s)]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(serverPids(s).length, 1);
  run(s, ['--stop']);
});

test('recovers a server that was killed without warning', { skip }, async () => {
  const [old] = serverPids(sandbox);
  process.kill(old, 'SIGKILL');
  await waitGone(old);
  assert.notEqual(await ping(sandbox.port), 200);

  const r = run(sandbox);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /starting on/);
  const pids = serverPids(sandbox);
  assert.equal(pids.length, 1);
  assert.notEqual(pids[0], old);
  assert.equal(await ping(sandbox.port), 200);
});

test('a recycled PID in server.pid is neither trusted nor killed', { skip }, async () => {
  assert.equal(run(sandbox, ['--stop']).code, 0);
  const bystander = spawn('sleep', ['120'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(sandbox.dataDir, 'server.pid'), `${bystander.pid}\n`);

  const started = Date.now();
  const r = run(sandbox);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /ignoring stale/);
  assert.ok(Date.now() - started < 30_000, 'did not wait on the unrelated process');
  assert.ok(alive(bystander.pid), 'unrelated process left alone');
  assert.ok(!serverPids(sandbox).includes(bystander.pid));
  assert.equal(await ping(sandbox.port), 200);
  bystander.kill();
});

test('a foreign process on the port is reported, not killed', { skip }, async () => {
  const s = await makeSandbox();
  const squatter = net.createServer((sock) => sock.destroy());
  await new Promise((r) => squatter.listen(s.port, '127.0.0.1', r));
  try {
    const r = await runAsync(s);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /port \d+ is held by a process that is not this script's FreeLLMAPI/);
    assert.equal(serverPids(s).length, 0);
    assert.ok(squatter.listening);
  } finally {
    await new Promise((r) => squatter.close(r));
  }
});

test('malformed FREEAPI_CONFIG_JSON is reported without echoing it', { skip }, async () => {
  fs.rmSync(path.join(sandbox.secretsDir, 'unified-key'), { force: true });
  const broken = config({ keys: [{ platform: 'groq', key: SECRET_PROVIDER_KEY }] }).slice(0, -1);
  const r = run(sandbox, ['--check'], { FREEAPI_CONFIG_JSON: broken });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /not valid JSON \(contents not shown\)/);
  for (const out of [r.stdout, r.stderr, fs.readFileSync(path.join(sandbox.dataDir, 'server.log'), 'utf8')]) {
    assert.ok(!out.includes(SECRET_PW) && !out.includes(SECRET_PROVIDER_KEY), 'no credential in output or log');
  }
});

test('setup codes never reach the log, including ones already there', { skip }, async () => {
  const s = await makeSandbox();
  fs.mkdirSync(s.dataDir, { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'server.log'), '  First-run setup code: OLDCODE1234\n  Password-reset code: OLDRESET99\n');
  const r = run(s, ['--check'], { FREEAPI_CONFIG_JSON: '' });
  assert.equal(r.code, 0, r.stderr);
  const log = fs.readFileSync(path.join(s.dataDir, 'server.log'), 'utf8');
  assert.ok(!log.includes('OLDCODE1234') && !log.includes('OLDRESET99'));
  assert.match(log, /setup code: <redacted>/i, 'the fresh code was redacted too');
  assert.doesNotMatch(log, /(setup|reset) code:\s*(?!<redacted>)\S/i);
  run(s, ['--stop']);
});

test('fails clearly without ENCRYPTION_KEY', { skip }, async () => {
  const s = await makeSandbox();
  const r = run(s, ['--check'], { ENCRYPTION_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ENCRYPTION_KEY is not set/);
});
