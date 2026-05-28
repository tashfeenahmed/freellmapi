import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getUnifiedApiKey } from '../db/index.js';

// Constant-time string comparison for the unified API key
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow health check ping without auth
  if (req.path === '/api/ping') {
    return next();
  }

  // Check Authorization header or x-api-key header
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] as string;
  const unifiedKey = getUnifiedApiKey();

  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid or missing API key', type: 'authentication_error' },
    });
    return;
  }

  next();
}
