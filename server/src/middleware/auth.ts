import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getUnifiedApiKey } from '../db/index.js';

/**
 * Sliding-window rate limiter, keyed by client IP.
 * Tracks request counts in memory with a per-minute window.
 */
interface RateWindow {
  count: number;
  resetAt: number;
}

const rateWindows = new Map<string, RateWindow>();
const RATE_LIMIT = 120;       // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

// Periodic cleanup to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of rateWindows) {
    if (now > w.resetAt) rateWindows.delete(key);
  }
}, 5 * 60_000);

function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  let w = rateWindows.get(clientIp);
  if (!w || now > w.resetAt) {
    w = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateWindows.set(clientIp, w);
  }
  w.count++;
  return w.count > RATE_LIMIT;
}

/**
 * Require a valid unified API key on every request.
 * Uses timing-safe comparison to prevent side-channel leaks.
 * Applies rate limiting per source IP.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';

  if (isRateLimited(clientIp)) {
    res.status(429).json({
      error: { message: 'Too many requests. Slow down.', type: 'rate_limit_error' },
    });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({
      error: { message: 'Missing API key. Provide a Bearer token.', type: 'authentication_error' },
    });
    return;
  }

  const provided = header.slice(7);
  const expected = getUnifiedApiKey();

  // Timing-safe comparison — always compare full-length buffers
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // If lengths differ, still do a comparison against a same-length dummy
  // to avoid leaking length info via timing
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  const compareB = b;

  if (!crypto.timingSafeEqual(compareA, compareB) || a.length !== b.length) {
    res.status(401).json({
      error: { message: 'Invalid API key.', type: 'authentication_error' },
    });
    return;
  }

  next();
}
