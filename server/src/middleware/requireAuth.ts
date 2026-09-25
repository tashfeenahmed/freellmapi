import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/auth.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  
  try {
    const session = await validateSession(token);
    if (!session) {
      res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
      return;
    }
    (req as Request & { user?: typeof session }).user = session;
    next();
  } catch (_err) {
    res.status(401).json({ error: { message: 'Authentication failed', type: 'authentication_error' } });
  }
}
