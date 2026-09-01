import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// #824: a user could not find the password-reset code because the desktop app
// prints it to a stdout nobody is attached to. The fix is a file log, so the
// thing worth asserting is that the reset code actually reaches the file.

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-logger-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  shell: { openPath: vi.fn() },
}));

const { createFileSink, installFileLogger, logFilePath, logsDir } = await import('../logger.js');
const { generateResetCode } = await import('../../../server/src/lib/reset-code.js');

afterAll(() => {
  // The tee keeps its file handle open until process exit, and Windows refuses
  // to unlink an open file — cleanup is a courtesy, not an assertion.
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // leave it to the OS temp sweeper
  }
});

describe('desktop file sink', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-sink-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines to freeapi.log, creating the directory', () => {
    const nested = path.join(dir, 'logs');
    const sink = createFileSink(nested);
    sink.write('first');
    sink.write('second');
    sink.close();
    expect(fs.readFileSync(path.join(nested, 'freeapi.log'), 'utf8')).toBe('first\nsecond\n');
  });

  it('keeps appending across sink instances rather than truncating', () => {
    const first = createFileSink(dir);
    first.write('one');
    first.close();
    const second = createFileSink(dir);
    second.write('two');
    second.close();
    expect(fs.readFileSync(path.join(dir, 'freeapi.log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('rotates to freeapi.log.1 at the size limit and keeps only two files', () => {
    const sink = createFileSink(dir, 40);
    sink.write('a'.repeat(30)); // 31 bytes
    sink.write('b'.repeat(30)); // would cross 40 → rotate first
    sink.write('c'.repeat(30)); // crosses again → rotate again, dropping the a's
    sink.close();
    expect(fs.readFileSync(path.join(dir, 'freeapi.log'), 'utf8')).toBe(`${'c'.repeat(30)}\n`);
    expect(fs.readFileSync(path.join(dir, 'freeapi.log.1'), 'utf8')).toBe(`${'b'.repeat(30)}\n`);
    expect(fs.readdirSync(dir).sort()).toEqual(['freeapi.log', 'freeapi.log.1']);
  });

  it('swallows filesystem errors instead of throwing at the caller', () => {
    const file = path.join(dir, 'blocked');
    fs.writeFileSync(file, '');
    // A file where the log directory should be: every fs call fails.
    const sink = createFileSink(file);
    expect(() => sink.write('nope')).not.toThrow();
    expect(() => sink.close()).not.toThrow();
  });
});

describe('console tee', () => {
  // Spy first, install second: the tee captures whatever console.log is at
  // install time, so the spy stands in for the original console it must keep
  // calling.
  const passthrough = vi.spyOn(console, 'log');
  installFileLogger();

  it('writes the password-reset code to the log file the user can open', () => {
    expect(logsDir()).toBe(path.join(userData, 'logs'));

    const code = generateResetCode();
    const written = fs.readFileSync(logFilePath(), 'utf8');

    expect(written).toContain(`Password-reset code: ${code}`);
    expect(written).toContain('Enter this code on the reset form');
  });

  it('still prints to the real console so a terminal run is unchanged', () => {
    passthrough.mockClear();
    console.log('hello from the tee');
    expect(passthrough).toHaveBeenCalledWith('hello from the tee');
    expect(fs.readFileSync(logFilePath(), 'utf8')).toContain('hello from the tee');
  });
});
