import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function npm(args, capture = false) {
  // npm.cmd requires cmd.exe on Windows. All shell arguments are fixed literals;
  // the project path is passed through cwd, never interpolated into a command.
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`]
    : args;
  const result = spawnSync(command, commandArgs, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`npm ${args.join(' ')} failed (${result.signal ?? result.status}).`);
    error.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
    throw error;
  }
  return (result.stdout ?? '').trim();
}

try {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/dev-start.mjs');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || major >= 25 || (major === 20 && minor < 18)) {
    throw new Error(`Node.js >=20.18.0 and <25.0.0 is required; found ${process.versions.node}.`);
  }
  const root = resolve(import.meta.dirname, '..');
  process.chdir(root);
  const npmVersion = npm(['--version'], true);
  if (!/^\d+\.\d+\.\d+/.test(npmVersion) || Number(npmVersion.split('.')[0]) < 10) {
    throw new Error(`npm >=10.0.0 is required; found ${npmVersion}.`);
  }

  const modules = join(root, 'node_modules');
  const stampPath = join(modules, '.freellmapi-start-lock');
  const expected = JSON.stringify({
    lock: createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex'),
    abi: process.versions.modules, platform: process.platform, arch: process.arch,
  });
  let installed = '';
  try {
    installed = readFileSync(stampPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (installed !== expected) {
    console.log('Installing dependencies from package-lock.json...');
    rmSync(stampPath, { force: true });
    npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
    mkdirSync(modules, { recursive: true });
    writeFileSync(stampPath, expected);
  } else {
    console.log('Dependencies already match package-lock.json and this Node.js runtime.');
  }

  // The server already loads .env and resolves persisted development keys.
  // Generating an env key here would override an existing key next to the DB.
  console.log('Starting FreeLLMAPI. Open the dashboard URL printed by Vite. Ctrl+C stops development.');
  npm(['run', 'dev']);
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
