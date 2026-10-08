import type { Server } from 'node:http';

/**
 * In a container the server is PID 1, and PID 1 gets no default action for
 * SIGTERM: without a handler `docker stop` — and every Watchtower self-update —
 * waits out its timeout and SIGKILLs the process mid-write. This stops taking
 * connections, lets in-flight requests finish, closes the database cleanly and
 * exits; a stuck request cannot hold the process past `graceMs`.
 */
export function installGracefulShutdown(options: {
  servers: () => Server[];
  closeDb: () => void;
  graceMs?: number;
  proc?: Pick<NodeJS.Process, 'once' | 'exit'>;
  logger?: Pick<Console, 'log' | 'error'>;
}): void {
  const proc = options.proc ?? process;
  const logger = options.logger ?? console;
  const graceMs = options.graceMs ?? 8_000;
  let stopping = false;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(`[server] ${signal} received — finishing in-flight requests and shutting down`);
    const force = setTimeout(() => {
      logger.error(`[server] still busy after ${graceMs} ms — exiting anyway`);
      proc.exit(1);
    }, graceMs);
    force.unref?.();

    const servers = options.servers();
    let open = servers.length;
    const finish = () => {
      try {
        options.closeDb();
      } catch (err) {
        logger.error(`[server] closing the database failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      clearTimeout(force);
      proc.exit(0);
    };
    if (open === 0) return finish();
    for (const server of servers) {
      server.close(() => {
        open -= 1;
        if (open === 0) finish();
      });
      // Keep-alive sockets with no request in flight would otherwise hold
      // close() open for the full 75 s keepAliveTimeout.
      server.closeIdleConnections?.();
    }
  };

  proc.once('SIGTERM', () => shutdown('SIGTERM'));
  proc.once('SIGINT', () => shutdown('SIGINT'));
}
