import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getUnifiedApiKey } from '../db/index.js';

export interface AdminAuthOptions {
  allowLocalBypass?: boolean;
}

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function isLocalRequest(req: Request): boolean {
  const isLocalPeer = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const host = req.hostname.toLowerCase();
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  return isLocalPeer && isLocalHost;
}

export function createAdminAuth(options: AdminAuthOptions = {}) {
  const allowLocalBypass = options.allowLocalBypass ?? true;

  return function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
    if (allowLocalBypass && isLocalRequest(req)) {
      next();
      return;
    }

    const token = bearerToken(req);
    if (token && timingSafeStringEqual(token, getUnifiedApiKey())) {
      next();
      return;
    }

    res.setHeader('WWW-Authenticate', 'Bearer realm="freellmapi-admin"');
    res.status(401).json({ error: { message: 'Admin authentication required' } });
  };
}
