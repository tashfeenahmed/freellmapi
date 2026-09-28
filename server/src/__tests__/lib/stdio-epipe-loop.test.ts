import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Regression: a server started with stdout/stderr piped to a process that then
// goes away (a shell tool that returned, a closed terminal) must not turn every
// console write into an EPIPE -> safety-net console.error -> server_logs row ->
// EPIPE loop. Observed in the wild at ~3-6k rows/s with zero traffic.

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, '..', 'fixtures', 'stdio-epipe-child.ts');

let child: ChildProcess | null = null;
let dir: string | null = null;

afterEach(async () => {
  const proc = child;
  child = null;
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
  }
  // The child held the DB open; Windows refuses to unlink until it is gone.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  dir = null;
});

function countRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM server_logs').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('dead stdio pipe', () => {
  it('does not feed an EPIPE loop into server_logs, and the process survives', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'freellmapi-epipe-'));
    const dbPath = path.join(dir, 'epipe.db');

    const proc = spawn(process.execPath, ['--import', 'tsx', childScript, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) },
    });
    child = proc;

    await new Promise<void>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`child never became ready: ${buf}`)), 20_000);
      proc.stdout!.on('data', (d) => {
        buf += d;
        if (buf.includes('child ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.stderr!.on('data', (d) => { buf += d; });
      proc.once('exit', (code) => reject(new Error(`child exited early (${code}): ${buf}`)));
    });

    const before = countRows(dbPath);
    proc.stdout!.destroy();
    proc.stderr!.destroy();
    await new Promise((r) => setTimeout(r, 2500));

    const grown = countRows(dbPath) - before;
    // ~5 legitimate periodic warns in the window; the loop writes thousands.
    expect(grown).toBeLessThan(50);
    expect(proc.exitCode).toBeNull();
  }, 40_000);
});
