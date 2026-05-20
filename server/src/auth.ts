import crypto from 'crypto';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

const SESSION_COOKIE = 'freellmapi_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_USERNAME = 'nguyenhoang287';
const DEFAULT_PASSWORD = 'Matkhau1@';

type SessionPayload = {
  sub: string;
  exp: number;
  nonce: string;
};

function authUsername(): string {
  return process.env.FREELLM_AUTH_USERNAME ?? process.env.AUTH_USERNAME ?? DEFAULT_USERNAME;
}

function authPassword(): string {
  return process.env.FREELLM_AUTH_PASSWORD ?? process.env.AUTH_PASSWORD ?? DEFAULT_PASSWORD;
}

function authSecret(): string {
  return process.env.FREELLM_AUTH_SECRET
    ?? process.env.AUTH_SECRET
    ?? process.env.ENCRYPTION_KEY
    ?? `${authUsername()}:${authPassword()}`;
}

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

function sign(value: string): string {
  return crypto.createHmac('sha256', authSecret()).update(value).digest('base64url');
}

function createSessionToken(username: string): string {
  const payload: SessionPayload = {
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function parseSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || !safeEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.nonce !== 'string') {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!safeEqual(payload.sub, authUsername())) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};

  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function hasSession(req: Request): boolean {
  return parseSessionToken(parseCookies(req)[SESSION_COOKIE]) !== null;
}

function secureCookie(req: Request): boolean {
  return process.env.VERCEL === '1'
    || process.env.NODE_ENV === 'production'
    || req.headers['x-forwarded-proto'] === 'https';
}

function serializeSessionCookie(req: Request, token: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secureCookie(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req: Request): string {
  return serializeSessionCookie(req, '', 0);
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return true;
  return /\.(?:css|js|map|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/i.test(pathname);
}

function authDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.FREELLM_AUTH_DISABLED === '1';
}

export const authRouter = Router();

authRouter.get('/session', (req: Request, res: Response) => {
  res.json({ authenticated: hasSession(req) });
});

authRouter.post('/login', (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  const validCredentials = typeof username === 'string'
    && typeof password === 'string'
    && safeEqual(username, authUsername())
    && safeEqual(password, authPassword());

  if (!validCredentials) {
    res.status(401).json({ error: { message: 'Invalid username or password' } });
    return;
  }

  res.setHeader('Set-Cookie', serializeSessionCookie(req, createSessionToken(username), SESSION_TTL_SECONDS));
  res.json({ authenticated: true });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  res.setHeader('Set-Cookie', clearSessionCookie(req));
  res.json({ success: true });
});

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (authDisabled() || isPublicPath(req.path) || hasSession(req)) {
    next();
    return;
  }

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  const nextPath = encodeURIComponent(req.originalUrl || '/');
  res.redirect(302, `/login?next=${nextPath}`);
}
