import type { Request, Response, NextFunction } from 'express';
import { verifySession } from '../lib/session.js';

const COOKIE_NAME = 'session';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }
  const session = verifySession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Session expired or invalid' } });
    return;
  }
  (req as any).session = session;
  next();
}
