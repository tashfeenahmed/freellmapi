import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./retry-network-step.sh', import.meta.url)).replaceAll('\\', '/');
const bash = process.env.CI_RETRY_BASH_EXE || 'bash';
function run({ failures = 0, message = '', exitCode = 47, attempts = '3', delay = '0' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-retry-test-'));
  const counter = path.join(directory, 'counter.json');
  const fixture = `import fs from 'node:fs';
    const p=process.argv[1];const n=(fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):0)+1;
    fs.writeFileSync(p,JSON.stringify(n));console.log('fixture attempt '+n);
    if(n<=${failures}){console.error(${JSON.stringify(message)});process.exit(${exitCode});}`;
  try {
    const result = spawnSync(bash, [script, 'node', '--input-type=module', '-e', fixture, counter], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, CI_NETWORK_RETRY_ATTEMPTS: attempts, CI_NETWORK_RETRY_DELAY_SECONDS: delay },
    });
    assert.ifError(result.error);
    return { ...result, count: fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter)) : 0 };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('successful command runs once and preserves its output', () => {
  const result = run(); assert.equal(result.status, 0); assert.equal(result.count, 1); assert.match(result.stdout, /fixture attempt 1/);
});
test('a GitHub Electron HTTP 504 recovers within a bounded number of attempts', () => {
  const result = run({ failures: 2, message: 'HTTPError: Response code 504 (Gateway Timeout)' });
  assert.equal(result.status, 0); assert.equal(result.count, 3); assert.equal((result.stdout.match(/::warning::/g) ?? []).length, 2);
});
test('electron-builder binary download errors use the same retry path', () => {
  const result = run({ failures: 1, message: 'cannot resolve https://github.com/example/tool.7z: status code 502' });
  assert.equal(result.status, 0); assert.equal(result.count, 2);
});
test('exhausted network retries preserve the original failure status', () => {
  const result = run({ failures: 9, message: 'npm error code ECONNRESET', exitCode: 42 });
  assert.equal(result.status, 42); assert.equal(result.count, 3);
});
test('ordinary failures are not retried or hidden', () => {
  const result = run({ failures: 9, message: 'packaging failed: missing application icon' });
  assert.equal(result.status, 47); assert.equal(result.count, 1);
});
test('compiler errors take precedence over an earlier transient-network warning', () => {
  const result = run({ failures: 9, message: 'prebuild warning ECONNRESET\nerror TS2345: incompatible argument' });
  assert.equal(result.status, 47); assert.equal(result.count, 1);
});
test('integrity, configuration and certificate failures are not retried', () => {
  for (const message of ['npm error code EINTEGRITY', 'ERR_ELECTRON_BUILDER_INVALID_CONFIGURATION', 'CERT_HAS_EXPIRED']) {
    const result = run({ failures: 9, message }); assert.equal(result.status, 47); assert.equal(result.count, 1);
  }
});
test('cancellation status is not retried even with a network error in the log', () => {
  const result = run({ failures: 9, message: 'ETIMEDOUT', exitCode: 143 }); assert.equal(result.status, 143); assert.equal(result.count, 1);
});
test('retry configuration is bounded and invalid values do not execute a command', () => {
  for (const attempts of ['0', '6', 'abc']) { const result = run({ attempts }); assert.equal(result.status, 2); assert.equal(result.count, 0); }
  const result = run({ delay: '61' }); assert.equal(result.status, 2); assert.equal(result.count, 0);
});
test('decimal delays with a leading zero do not trigger bash octal parsing', () => {
  const result = run({ delay: '08' }); assert.equal(result.status, 0); assert.equal(result.count, 1);
});
test('command arguments are passed literally rather than evaluated by a shell', () => {
  const literal = 'spaces; $(not_a_command) & | < >';
  const result = spawnSync(bash, [script, 'node', '-e', 'console.log(process.argv[1])', literal], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), literal);
});
