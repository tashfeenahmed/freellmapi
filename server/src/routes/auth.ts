import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  userCount,
  createUser,
  verifyCredentials,
  createSession,
  validateSession,
  deleteSession,
  updateEmail,
  updatePassword,
  normalizeEmail,
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode } from '../lib/setup-code.js';

export const authRouter = Router();

const signupSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// Bound the map so a flood of distinct addresses cannot grow it without limit;
// expired buckets are pruned opportunistically, mirroring the per-IP limiter in
// middleware/rateLimit.ts.
const MAX_TRACKED_EMAILS = 10_000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

// The bucket key MUST be the same spelling verifyCredentials looks the user up
// by. Keying on `.toLowerCase()` alone while the lookup also trimmed meant
// " admin@example.com" authenticated against the admin row but landed in its
// own bucket, so every whitespace variant handed the guesser another five
// tries and the lockout never engaged.
function throttleKey(email: string): string {
  return normalizeEmail(email);
}
function isLockedOut(email: string): boolean {
  const a = attempts.get(throttleKey(email));
  return !!a && a.lockedUntil > Date.now();
}

function recordFailure(email: string): void {
  const key = throttleKey(email);
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
  if (attempts.size > MAX_TRACKED_EMAILS) {
    const now = Date.now();
    for (const [tracked, state] of attempts) {
      if (tracked !== key && state.lockedUntil <= now) attempts.delete(tracked);
    }
  }
}

function clearFailures(email: string): void {
  attempts.delete(throttleKey(email));
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

function isLoopbackAddress(value: string | undefined): boolean {
  let addr = (value ?? '').trim();
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// Is the caller connecting from the local machine? The socket peer address is
// the authority, NOT req.ip: forwarded headers are attacker-controlled, so
// letting one of them ASSERT locality would hand a remote caller the setup
// code exemption outright.
//
// But the socket peer alone is not sufficient either, because the reverse-proxy
// deployment this project documents (docs/en/proxy/OVERVIEW.md, and
// docs/en/troubleshooting/01-common-issues.md on TRUST_PROXY) puts Caddy/nginx/
// Traefik on the SAME host: every request then arrives from 127.0.0.1 and the
// socket test is true for the entire internet. So a forwarded hop can never
// grant locality, but it can withdraw it — exactly the treatment the Ollama
// open-loopback mode already applies in routes/ollama.ts:25-38.
function isLoopbackRemote(req: Request): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0];
  // A local reverse proxy is itself a loopback socket, but its first forwarded
  // hop may be remote. Refuse that request rather than silently widening the
  // no-code first-run path through the proxy.
  return !firstForwarded || isLoopbackAddress(firstForwarded);
}

authRouter.get('/status', async (req: Request, res: Response) => {
  const count = await userCount();
  const session = await validateSession(bearer(req));
  res.json({
    needsSetup: count === 0,
    authenticated: !!session,
    email: session?.email ?? null,
  });
});

authRouter.post('/setup', async (req: Request, res: Response) => {
  const count = await userCount();
  if (count > 0) {
    res.status(403).json({ error: { message: 'Dashboard is already set up', type: 'forbidden_error' } });
    return;
  }

  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors[0]?.message ?? 'Invalid input', type: 'invalid_request_error' } });
    return;
  }

  const { email, password } = parsed.data;
  const setupCode = typeof req.body.setupCode === 'string' ? req.body.setupCode.trim() : '';

  if (!isLoopbackRemote(req) && !setupCodeMatches(setupCode)) {
    res.status(403).json({ error: { message: 'Invalid or missing setup code', type: 'forbidden_error' } });
    return;
  }

  try {
    const user = await createUser(email, password);
    clearSetupCode();
    const token = await createSession(user.userId);
    res.status(201).json({ token, email: user.email });
  } catch (err: any) {
    if (err?.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'conflict_error' } });
      return;
    }
    res.status(500).json({ error: { message: 'Setup failed', type: 'server_error' } });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors[0]?.message ?? 'Invalid input', type: 'invalid_request_error' } });
    return;
  }

  const { email, password } = parsed.data;
  if (isLockedOut(email)) {
    res.status(429).json({ error: { message: 'Too many attempts. Wait 15 minutes or restart the app.', type: 'rate_limit_error' } });
    return;
  }

  const user = await verifyCredentials(email, password);
  if (!user) {
    recordFailure(email);
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email);
  const token = await createSession(user.userId);
  res.json({ token, email: user.email });
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  await deleteSession(bearer(req));
  res.status(204).end();
});

authRouter.get('/me', async (req: Request, res: Response) => {
  const session = await validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: session.email, userId: session.userId });
});

authRouter.put('/email', async (req: Request, res: Response) => {
  const session = await validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  const parsed = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newEmail: z.string().email('A valid new email is required'),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors[0]?.message ?? 'Invalid input', type: 'invalid_request_error' } });
    return;
  }

  try {
    const success = await updateEmail(session.userId, parsed.data.currentPassword, parsed.data.newEmail);
    if (!success) {
      res.status(401).json({ error: { message: 'Incorrect current password', type: 'authentication_error' } });
      return;
    }
    res.json({ success: true, email: parsed.data.newEmail.trim().toLowerCase() });
  } catch (err: any) {
    if (err?.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'conflict_error' } });
      return;
    }
    res.status(500).json({ error: { message: 'Failed to update email', type: 'server_error' } });
  }
});

authRouter.put('/password', async (req: Request, res: Response) => {
  const session = await validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  const parsed = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(8, 'New password must be at least 8 characters'),
  }).safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors[0]?.message ?? 'Invalid input', type: 'invalid_request_error' } });
    return;
  }

  const success = await updatePassword(session.userId, parsed.data.currentPassword, parsed.data.newPassword);
  if (!success) {
    res.status(401).json({ error: { message: 'Incorrect current password', type: 'authentication_error' } });
    return;
  }

  // Issue fresh token since old sessions are deleted
  const newToken = await createSession(session.userId);
  res.json({ success: true, token: newToken });
});
