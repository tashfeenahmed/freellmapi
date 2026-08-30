// A file log for the desktop app (#824).
//
// The embedded server writes operational output to the console — including the
// one-time password-reset code, which POST /api/auth/forgot-password prints and
// nothing else ever shows. A server operator reads it from `docker logs` or the
// terminal; a Finder/Explorer-launched Electron app has no attached stdout, so
// that code was unreadable and the reset flow could never be completed.
//
// So tee console output into <userData>/logs/freeapi.log. Writes are synchronous
// (a code printed a moment before the app quits must already be on disk) and
// every filesystem call is wrapped: logging must never be the reason the app
// fails to start.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { app, shell } from 'electron';

const LOG_NAME = 'freeapi.log';
// Two files, 1 MB each: enough history to cover a reset or a bad boot, small
// enough that nobody's disk notices.
const MAX_LOG_BYTES = 1024 * 1024;
const PREVIOUS_NAME = `${LOG_NAME}.1`;

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

export function logFilePath(): string {
  return path.join(logsDir(), LOG_NAME);
}

export interface FileSink {
  write(line: string): void;
  close(): void;
}

// The sink itself, free of electron so it can be exercised in tests: appends to
// <dir>/freeapi.log and rotates it to freeapi.log.1 once it passes maxBytes.
export function createFileSink(dir: string, maxBytes: number = MAX_LOG_BYTES): FileSink {
  const current = path.join(dir, LOG_NAME);
  const previous = path.join(dir, PREVIOUS_NAME);
  let fd: number | null = null;
  let size = 0;

  function open(): void {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(current, 'a');
    size = fs.fstatSync(fd).size;
  }

  function rotate(): void {
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }
    fs.rmSync(previous, { force: true });
    fs.renameSync(current, previous);
    open();
  }

  return {
    write(line: string): void {
      try {
        if (fd === null) open();
        const buf = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
        // Rotate before the write that would cross the limit, never on an empty
        // file — a single line longer than maxBytes must not loop.
        if (size > 0 && size + buf.length > maxBytes) rotate();
        fs.writeSync(fd as number, buf);
        size += buf.length;
      } catch {
        // A read-only or full disk is not worth crashing over; drop the line.
      }
    },
    close(): void {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // already gone
      }
      fd = null;
    },
  };
}

let installed = false;

// Wrap console.log/info/warn/error so everything the app and the embedded
// server print also lands in the log file. The original console is still
// called, so `npm run dev` output is unchanged.
export function installFileLogger(dir: string = logsDir()): void {
  if (installed) return;
  installed = true;
  let sink: FileSink;
  try {
    sink = createFileSink(dir);
  } catch {
    return;
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        sink.write(`${new Date().toISOString()} [${level}] ${util.format(...args)}`);
      } catch {
        // never let logging break the caller
      }
    };
  }
  process.on('exit', () => sink.close());
  console.log(`[desktop] writing logs to ${path.join(dir, LOG_NAME)}`);
}

// Tray → "Open Logs Folder". Create the directory first so the reveal works
// even before anything has been written.
export function openLogsFolder(): void {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  } catch (err) {
    console.warn('[desktop] could not open the logs folder:', err);
  }
}

// Tray → "Open Backups Folder". The server writes dumps to <db dir>/backups
// (server/src/services/backups.ts dataDir()) and main.ts puts the DB at
// <userData>/freeapi.db, so this is where they land — the dashboard's Backups
// panel only ever shows paths relative to that directory, which a desktop
// user has no other way to locate.
export function openBackupsFolder(): void {
  try {
    const dir = path.join(app.getPath('userData'), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  } catch (err) {
    console.warn('[desktop] could not open the backups folder:', err);
  }
}
