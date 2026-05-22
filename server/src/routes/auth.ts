import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { getDashboardEmail, getDashboardPassword } from '../env.js';
import { signSession, verifySession } from '../lib/session.js';

export const authRouter = Router();

const COOKIE_NAME = 'session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60,
};

authRouter.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: { message: 'email and password required' } });
    return;
  }

  const expectedEmail = getDashboardEmail();
  const expectedPassword = getDashboardPassword();

  const emailBuf = Buffer.from(email);
  const expEmailBuf = Buffer.from(expectedEmail);
  const passBuf = Buffer.from(password);
  const expPassBuf = Buffer.from(expectedPassword);

  const emailMatch =
    emailBuf.length === expEmailBuf.length &&
    crypto.timingSafeEqual(emailBuf, expEmailBuf);
  const passMatch =
    passBuf.length === expPassBuf.length &&
    crypto.timingSafeEqual(passBuf, expPassBuf);

  if (!emailMatch || !passMatch) {
    res.status(401).json({ error: { message: 'Invalid credentials' } });
    return;
  }

  const token = signSession(email);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.json({ ok: true, email });
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: { message: 'Not authenticated' } });
    return;
  }
  const session = verifySession(token);
  if (!session) {
    res.status(401).json({ error: { message: 'Session expired or invalid' } });
    return;
  }
  res.json({ email: session.email });
});
