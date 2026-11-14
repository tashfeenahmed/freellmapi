import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown } from '../../lib/graceful-shutdown.js';

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  return { proc: { once: emitter.once.bind(emitter), exit } as any, emitter, exit };
}

describe('installGracefulShutdown', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('closes the server and the database on SIGTERM, then exits 0', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { proc, emitter, exit } = fakeProcess();
    const closeDb = vi.fn();
    installGracefulShutdown({ servers: () => [server], closeDb, proc, logger: { log: vi.fn(), error: vi.fn() } });

    emitter.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  });

  it('exits non-zero when a request outlives the grace period', async () => {
    vi.useFakeTimers();
    const stuck = { close: vi.fn(), closeIdleConnections: vi.fn() } as unknown as http.Server;
    const { proc, emitter, exit } = fakeProcess();
    installGracefulShutdown({ servers: () => [stuck], closeDb: vi.fn(), proc, graceMs: 500, logger: { log: vi.fn(), error: vi.fn() } });

    emitter.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('handles the second signal of a double Ctrl-C only once', async () => {
    const { proc, emitter, exit } = fakeProcess();
    const closeDb = vi.fn();
    installGracefulShutdown({ servers: () => [], closeDb, proc, logger: { log: vi.fn(), error: vi.fn() } });
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  // M39: background jobs (health checks, catalog sync, backups…) kept firing
  // during the drain and could start work against a database about to close.
  it('stops background jobs before it closes anything', async () => {
    const order: string[] = [];
    const { proc, emitter, exit } = fakeProcess();
    installGracefulShutdown({
      servers: () => [],
      stopJobs: () => { order.push('jobs') },
      closeDb: () => { order.push('db') },
      proc,
      logger: { log: vi.fn(), error: vi.fn() },
    });
    emitter.emit('SIGTERM');
    expect(order).toEqual(['jobs', 'db']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still closes the database when a job refuses to stop', () => {
    const { proc, emitter, exit } = fakeProcess();
    const closeDb = vi.fn();
    const logger = { log: vi.fn(), error: vi.fn() };
    installGracefulShutdown({ servers: () => [], stopJobs: () => { throw new Error('busy') }, closeDb, proc, logger });
    emitter.emit('SIGTERM');
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // M39: the forced exit skipped closeDb, so the WAL was left un-checkpointed
  // on every shutdown that hit the grace limit.
  it('closes the database on the forced exit too', () => {
    vi.useFakeTimers();
    const stuck = { close: vi.fn(), closeIdleConnections: vi.fn() } as unknown as http.Server;
    const { proc, emitter, exit } = fakeProcess();
    const closeDb = vi.fn();
    installGracefulShutdown({ servers: () => [stuck], closeDb, proc, graceMs: 500, logger: { log: vi.fn(), error: vi.fn() } });

    emitter.emit('SIGTERM');
    vi.advanceTimersByTime(500);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
