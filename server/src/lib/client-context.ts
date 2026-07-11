import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
const storage = new AsyncLocalStorage<ClientContext>();

// Resolve the client IP from the socket peer address. The X-Forwarded-For
// header is only trusted when Express's "trust proxy" setting is enabled
// (opt-in via app.set('trust proxy', ...) or the TRUST_PROXY env var in
// run.ts). Without that, a spoofed header from a LAN client is ignored.
function resolveClientIp(req: Request): string | null {
  const trustProxy = req.app?.get('trust proxy') ?? false;
  let raw: string | null;
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    raw = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
  } else {
    raw = req.socket.remoteAddress || null;
  }
  // Normalize IPv4-mapped IPv6 ("::ffff:192.168.0.5" -> "192.168.0.5").
  return raw?.replace(/^::ffff:/i, '') ?? null;
}

// Privacy opt-out: REQUEST_ANALYTICS_LOG_CLIENT=false stores nulls instead of
// the caller's IP/UA. Read per request (not at module load) so tests and
// embedders can toggle it without re-importing.
function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!clientLoggingEnabled()) {
    storage.run({ ip: null, userAgent: null }, next);
    return;
  }
  const ua = req.headers['user-agent'];
  storage.run({ ip: resolveClientIp(req), userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null }, next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null };
}
