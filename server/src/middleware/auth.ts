import type { Request, Response, NextFunction } from 'express';
import { getSession } from '../lib/session.js';

export async function attachSession(req: Request, res: Response, next: NextFunction) {
  try {
    req.session = await getSession(req, res);
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.userId == null) {
    res.status(401).json({
      error: {
        message: 'Unauthorized',
        type: 'auth_required',
      },
    });
    return;
  }
  next();
}
