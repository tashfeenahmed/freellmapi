import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
  /**
   * Provider-reported request size from a 4xx error on a prior attempt in
   * this same request. Set by recordRetryableFailure in lib/fallback-loop.ts
   * when a provider names the real token count in its error body (Groq,
   * OpenRouter, Cloudflare). Consumed by selectKeyForModel in services/router.ts
   * to skip subsequent models whose TPM ceiling is below this number, so a
   * single first 413 saves every downstream doomed attempt.
   * null = no provider has reported a real size yet; the local estimator is
   * in charge. Never decreases — once observed, the larger value sticks so
   * an early small-size report can't under-skip a later larger request.
   */
  observedRequestTokens: number | null;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
// `observedRequestTokens` rides the same store so the fallback loop can write
// it once per request and the router can read it on every iteration without
// extending any function signatures.
const storage = new AsyncLocalStorage<ClientContext>();

// First X-Forwarded-For hop when present (reverse-proxy deployments, e.g.
// Traefik), otherwise the socket peer address. The server is LAN-only, so a
// spoofable header is an acceptable trade for working behind a proxy.
function resolveClientIp(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  const raw = first || req.socket.remoteAddress || null;
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
  const ctx: ClientContext = {
    ip: null,
    userAgent: null,
    observedRequestTokens: null,
  };
  if (clientLoggingEnabled()) {
    const ua = req.headers['user-agent'];
    ctx.ip = resolveClientIp(req);
    ctx.userAgent = typeof ua === 'string' ? ua.slice(0, 256) : null;
  }
  storage.run(ctx, next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null, observedRequestTokens: null };
}

/**
 * Record a provider-reported request size on the current request's context.
 * Called by lib/fallback-loop.ts when an upstream 4xx names the real token
 * count in its error body. Sticky: once set, the larger value wins so an
 * early small-size report can't under-skip a later larger request. Reads
 * from the AsyncLocalStorage store so the caller doesn't need to thread
 * the value through every layer.
 */
export function setObservedRequestTokens(tokens: number): void {
  const ctx = storage.getStore();
  if (!ctx) return;          // not in a request context — ignore (tests, startup)
  ctx.observedRequestTokens = Math.max(ctx.observedRequestTokens ?? 0, tokens);
}

/** Current sticky observed request size, or null when no provider has reported one. */
export function getObservedRequestTokens(): number | null {
  return storage.getStore()?.observedRequestTokens ?? null;
}
