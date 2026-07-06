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
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode } from '../lib/setup-code.js';

export const authRouter = Router();

// Dashboard auth (#35). These routes are mounted BEFORE requireAuth, so
// /status, /setup and /login are reachable without a session (bootstrap);
// /logout and /me validate the token themselves.

const credentialsSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// ── Brute-force throttle ──────────────────────────────────────────────────
// Simple in-memory per-email limiter. A local single-user tool doesn't need a
// distributed store; this just blunts online password guessing.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; lockedUntil: number }>();

function isLockedOut(email: string): boolean {
  const a = attempts.get(email.toLowerCase());
  return !!a && a.lockedUntil > Date.now();
}
function recordFailure(email: string): void {
  const key = email.toLowerCase();
  const a = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
  }
  attempts.set(key, a);
}
function clearFailures(email: string): void {
  attempts.delete(email.toLowerCase());
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

// Is the caller connecting from the local machine? We check the actual socket
// peer address, NOT req.ip or X-Forwarded-For: those are attacker-controlled
// behind a proxy (and trust proxy is off by default anyway), so trusting them
// here would let a remote caller pretend to be local and skip the setup code.
function isLoopbackRemote(req: Request): boolean {
  let addr = req.socket.remoteAddress ?? '';
  // Node reports IPv4 loopback over a dual-stack socket as "::ffff:127.0.0.1".
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// Has the dashboard been set up yet, and is this caller authenticated?
authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  res.json({
    needsSetup: userCount() === 0,
    authenticated: !!session,
    email: session?.email ?? null,
  });
});

// First-run account creation. Only allowed while there are zero users, so it
// can't be used to add accounts once the dashboard is claimed.
authRouter.post('/setup', (req: Request, res: Response) => {
  if (userCount() > 0) {
    clearSetupCode();
    res.status(409).json({ error: { message: 'Setup already completed. Use login instead.', type: 'setup_complete' } });
    return;
  }

  // Local/desktop first-run stays frictionless: a browser on this machine can
  // claim the dashboard without any code. A remote caller must present the
  // one-time setup code logged at boot, so an exposed fresh install can't be
  // claimed by a stranger who finds it first.
  if (!isLoopbackRemote(req) && !setupCodeMatches((req.body ?? {}).setupCode)) {
    res.status(403).json({
      error: {
        message: 'A setup code is required to create the first account from a remote device. ' +
          'Check the server logs for the code, or open the dashboard from a browser on the machine running FreeLLMAPI.',
        type: 'setup_code_required',
      },
    });
    return;
  }

  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  clearSetupCode(); // one-time: the dashboard is now claimed
  const token = createSession(user.userId);
  res.status(201).json({ token, email: user.email });
});

authRouter.post('/login', (req: Request, res: Response) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  if (isLockedOut(email)) {
    res.status(429).json({ error: { message: 'Too many failed attempts. Try again later.', type: 'rate_limit_error' } });
    return;
  }

  const user = verifyCredentials(email, password);
  if (!user) {
    recordFailure(email);
    // Same message whether the email exists or not — don't leak which.
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email);
  const token = createSession(user.userId);
  res.json({ token, email: user.email });
});

authRouter.post('/logout', (req: Request, res: Response) => {
  deleteSession(bearer(req));
  res.json({ success: true });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({ email: session.email });
});
