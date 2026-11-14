import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, '..');

async function makeFixture(t, { devExitCode = 0 } = {}) {
  // Exercise shell quoting too: the entry points must work outside the repo's cwd.
  const root = await mkdtemp(join(tmpdir(), 'freellmapi start & fixture '));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await copyFile(join(projectRoot, 'scripts/dev-start.mjs'), join(root, 'scripts/dev-start.mjs'));
  await copyFile(join(projectRoot, 'Start.cmd'), join(root, 'Start.cmd'));
  await copyFile(join(projectRoot, 'Start.command'), join(root, 'Start.command'));
  await mkdir(join(root, 'fixture-dependency'));
  await writeFile(join(root, 'fixture-dependency/package.json'), JSON.stringify({
    name: 'fixture-dependency', version: '1.0.0', main: 'index.cjs',
  }));
  await writeFile(join(root, 'fixture-dependency/index.cjs'), 'module.exports = "installed";\n');
  const manifest = {
    name: 'start-fixture', version: '1.0.0', private: true,
    scripts: { preinstall: 'node install.cjs', dev: 'node dev.cjs' },
    dependencies: { 'fixture-dependency': 'file:fixture-dependency' },
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      'fixture-dependency': { version: '1.0.0' },
      'node_modules/fixture-dependency': { resolved: 'fixture-dependency', link: true },
    },
  }));
  await writeFile(join(root, 'install.cjs'), `
const fs = require('node:fs');
fs.appendFileSync('installs.log', 'install\\n');
if (fs.existsSync('fail-install')) process.exit(9);
`);
  await writeFile(join(root, 'dev.cjs'), `
const fs = require('node:fs');
const dependency = require('fixture-dependency');
fs.appendFileSync('starts.log', JSON.stringify({
  cwd: process.cwd(), dependency, key: process.env.ENCRYPTION_KEY ?? null,
}) + '\\n');
process.exitCode = ${devExitCode};
`);
  // Real npm with a local dependency: these tests never need the registry.
  const env = {
    ...process.env,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_cache: join(root, 'npm-cache'),
  };
  delete env.ENCRYPTION_KEY;
  delete env.NODE_ENV;
  delete env.npm_config_ignore_scripts;
  delete env.npm_config_production;
  delete env.npm_config_omit;
  return { root, env };
}

async function run(fixture, entry = 'node') {
  let command = process.execPath;
  let args = [join(fixture.root, 'scripts/dev-start.mjs')];
  if (entry === 'cmd') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `""${join(fixture.root, 'Start.cmd')}""`];
  } else if (entry === 'bash') {
    command = 'bash';
    args = [join(fixture.root, 'Start.command')];
  }
  try {
    return { code: 0, ...await execFile(command, args, {
      cwd: tmpdir(), env: fixture.env, timeout: 60_000,
      windowsVerbatimArguments: entry === 'cmd',
    }) };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function lines(root, name) {
  return (await readFile(join(root, name), 'utf8')).trim().split('\n');
}

function assertSuccess(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
}

test('fresh start installs locked dependencies and runs dev from the project root without creating .env', async (t) => {
  const fixture = await makeFixture(t);
  const lockBefore = await readFile(join(fixture.root, 'package-lock.json'), 'utf8');
  assertSuccess(await run(fixture));
  assert.deepEqual((await lines(fixture.root, 'starts.log')).map(JSON.parse), [{
    cwd: fixture.root, dependency: 'installed', key: null,
  }]);
  assert.equal((await lines(fixture.root, 'installs.log')).length, 1);
  assert.equal(await readFile(join(fixture.root, 'package-lock.json'), 'utf8'), lockBefore);
  await assert.rejects(readFile(join(fixture.root, '.env')), { code: 'ENOENT' });
});

test('repeat start skips installation; a changed lockfile reinstalls before starting', async (t) => {
  const fixture = await makeFixture(t);
  assertSuccess(await run(fixture));
  assertSuccess(await run(fixture));
  assert.equal((await lines(fixture.root, 'installs.log')).length, 1);
  const manifest = JSON.parse(await readFile(join(fixture.root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(fixture.root, 'package-lock.json'), 'utf8'));
  manifest.version = lock.version = lock.packages[''].version = '1.0.1';
  await writeFile(join(fixture.root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(fixture.root, 'package-lock.json'), JSON.stringify(lock));
  assertSuccess(await run(fixture));
  assert.equal((await lines(fixture.root, 'installs.log')).length, 2);
  assert.equal((await lines(fixture.root, 'starts.log')).length, 3);
});

test('a missing installation stamp triggers installation again', async (t) => {
  const fixture = await makeFixture(t);
  assertSuccess(await run(fixture));
  await rm(join(fixture.root, 'node_modules/.freellmapi-start-lock'));
  assertSuccess(await run(fixture));
  assert.equal((await lines(fixture.root, 'installs.log')).length, 2);
});

test('existing .env and data stay byte-for-byte unchanged and inherited configuration reaches dev', async (t) => {
  const fixture = await makeFixture(t);
  fixture.env.ENCRYPTION_KEY = 'b'.repeat(64);
  const files = {
    '.env': 'ENCRYPTION_KEY=' + 'a'.repeat(64) + '\r\nPORT=4444\r\n',
    'server/data/.encryption-key': 'c'.repeat(64),
    'server/data/database.db': 'existing database fixture',
  };
  await mkdir(join(fixture.root, 'server/data'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(fixture.root, name), content);
  assertSuccess(await run(fixture));
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(join(fixture.root, name), 'utf8'), content);
  assert.equal(JSON.parse((await lines(fixture.root, 'starts.log'))[0]).key, fixture.env.ENCRYPTION_KEY);
});

test('an installation using a saved key without .env is not assigned a new environment key', async (t) => {
  const fixture = await makeFixture(t);
  const key = 'd'.repeat(64);
  await mkdir(join(fixture.root, 'server/data'), { recursive: true });
  await writeFile(join(fixture.root, 'server/data/.encryption-key'), key);
  assertSuccess(await run(fixture));
  await assert.rejects(readFile(join(fixture.root, '.env')), { code: 'ENOENT' });
  assert.equal(await readFile(join(fixture.root, 'server/data/.encryption-key'), 'utf8'), key);
  assert.equal(JSON.parse((await lines(fixture.root, 'starts.log'))[0]).key, null);
});

test('failed installation does not start dev or mark dependencies ready; retry recovers', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(join(fixture.root, 'fail-install'), '');
  const result = await run(fixture);
  assert.notEqual(result.code, 0);
  await assert.rejects(readFile(join(fixture.root, 'starts.log')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(fixture.root, 'node_modules/.freellmapi-start-lock')), { code: 'ENOENT' });
  await rm(join(fixture.root, 'fail-install'));
  assertSuccess(await run(fixture));
  assert.equal((await lines(fixture.root, 'starts.log')).length, 1);
});

test('the dev exit status is returned to the caller', async (t) => {
  const fixture = await makeFixture(t, { devExitCode: 7 });
  assert.equal((await run(fixture)).code, 7);
});

test('Start.cmd works from another directory with spaces and shell metacharacters in the path', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await makeFixture(t);
  assertSuccess(await run(fixture, 'cmd'));
  assert.equal(JSON.parse((await lines(fixture.root, 'starts.log'))[0]).cwd, fixture.root);
});

test('Start.command works from another directory with spaces and shell metacharacters in the path', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = await makeFixture(t);
  assertSuccess(await run(fixture, 'bash'));
  assert.equal(JSON.parse((await lines(fixture.root, 'starts.log'))[0]).cwd, fixture.root);
});
