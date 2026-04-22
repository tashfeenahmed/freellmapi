import { getIronSession, type SessionOptions, type IronSession } from 'iron-session';
import type { Request, Response } from 'express';

const EIGHT_HOURS_SEC = 60 * 60 * 8;

export type SessionData = {
  userId?: number;
  username?: string;
  role?: string;
  loggedInAt?: number;
};

export type AppSession = IronSession<SessionData>;

const baseSessionOptions: Omit<SessionOptions, 'password'> = {
  cookieName: 'freellmapi_session',
  ttl: EIGHT_HOURS_SEC,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  },
};

export async function getSession(req: Request, res: Response): Promise<AppSession> {
  const password = process.env.SESSION_PASSWORD ?? '';
  return getIronSession<SessionData>(req, res, {
    ...baseSessionOptions,
    password,
  });
}
