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
  resetUserPassword,
  accountEmail,
  normalizeEmail,
  desktopSessionToken,
} from '../services/auth.js';
import { setupCodeMatches, clearSetupCode } from '../lib/setup-code.js';
import { isLocalRequest } from '../lib/loopback.js';
import { generateResetCode, resetCodeMatches, clearResetCode } from '../lib/reset-code.js';

export const authRouter = Router();

const failedPasswordAttempts = new Map<number, number>();

// Dashboard auth (#35). These routes are mounted BEFORE requireAuth, so
// /status, /setup and /login are reachable without a session (bootstrap);
// /logout and /me validate the token themselves.

// Signing up is the one place the address has to look like an address.
const signupSchema = z.object({
  email: z.string().email('A valid email is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Logging in is a lookup, not a registration, so the address is matched rather
// than validated. The desktop app seeds its hidden account as
// `desktop@localhost` (server-host.ts), which has no TLD and so could never
// satisfy z.email() — every login attempt on a desktop install failed with
// "A valid email is required" before the password was even checked, including
// the reset-then-sign-in-from-a-browser route suggested in #807. Length rules
// belong to signup too: an account created under an older policy must still be
// able to get in.
const loginSchema = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

// ── Brute-force throttle ──────────────────────────────────────────────────
// In-memory; a local single-user tool doesn't need a distributed store, this
// just blunts online password guessing. Every failed login counts in two
// buckets:
//  - address + client IP, 5 tries: locks out one guesser. Keyed on the address
//    alone, five bad guesses from anywhere locked the OWNER out too, correct
//    password and all, and the address is guessable (`desktop@localhost`).
//  - address alone, 50 tries: an account-wide cap, so a guesser rotating IPs
//    still gets at most 50 tries per window.
// Failures only count within a LOCKOUT_MS window, so occasional typos spread
// over days never add up to a lockout.
const MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS_ALL_CLIENTS = 50;
const LOCKOUT_MS = 15 * 60 * 1000;
// Bound the map so a flood of distinct addresses cannot grow it without limit;
// expired buckets are pruned opportunistically, mirroring the per-IP limiter in
// middleware/rateLimit.ts.
const MAX_TRACKED_EMAILS = 10_000;
const attempts = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();

// The address MUST be the same spelling verifyCredentials looks the user up
// by. Keying on `.toLowerCase()` alone while the lookup also trimmed meant
// " admin@example.com" authenticated against the admin row but landed in its
// own bucket, so every whitespace variant handed the guesser another five
// tries and the lockout never engaged. Keys are JSON tuples so no address can
// spell another bucket's key (an address may contain any separator).
function throttleBuckets(email: string, ip: string | undefined): Array<[key: string, max: number]> {
  const address = normalizeEmail(email);
  return [
    [JSON.stringify([address, ip ?? '']), MAX_ATTEMPTS],
    [JSON.stringify([address]), MAX_ATTEMPTS_ALL_CLIENTS],
  ];
}
// Seconds until the lockout lifts for this address from this client (0 when
// not locked). The 429 carries this as Retry-After so a client (or a scripted
// login retry loop) backs off for the ACTUAL remaining time instead of the
// worst-case 15 min.
function lockoutRetryAfterSec(email: string, ip: string | undefined, now = Date.now()): number {
  let until = 0;
  for (const [key] of throttleBuckets(email, ip)) until = Math.max(until, attempts.get(key)?.lockedUntil ?? 0);
  return until > now ? Math.max(1, Math.ceil((until - now) / 1000)) : 0;
}
function recordFailure(email: string, ip: string | undefined): void {
  const now = Date.now();
  const buckets = throttleBuckets(email, ip);
  for (const [key, max] of buckets) {
    let a = attempts.get(key);
    if (!a || now - a.windowStart > LOCKOUT_MS) a = { count: 0, windowStart: now, lockedUntil: a?.lockedUntil ?? 0 };
    a.count++;
    if (a.count >= max) {
      a.lockedUntil = now + LOCKOUT_MS;
      a.count = 0;
    }
    attempts.set(key, a);
  }
  if (attempts.size > MAX_TRACKED_EMAILS) {
    for (const [tracked, state] of attempts) {
      if (!buckets.some(([key]) => key === tracked) && state.lockedUntil <= now) attempts.delete(tracked);
    }
  }
}
function clearFailures(email: string, ip: string | undefined): void {
  for (const [key] of throttleBuckets(email, ip)) attempts.delete(key);
}
// A completed password reset proves control of the install, so it lifts every
// lock on the account, from every client.
function clearAccountLockouts(email: string): void {
  const address = normalizeEmail(email);
  for (const key of attempts.keys()) {
    if ((JSON.parse(key) as string[])[0] === address) attempts.delete(key);
  }
}

function bearer(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
}

// ── Desktop sign-in (#1399) ───────────────────────────────────────────────
// The desktop app's account is a hidden machine user with a random password
// nobody knows. Its own window gets sessions over IPC, but the same dashboard
// opened in a normal browser tab (the tray's "Open in browser", a bookmark,
// http://127.0.0.1:31415) used to land on a Sign In form nobody could pass.
// On a desktop install, a request from this machine gets the session the
// window would have got, so the form never shows.
//
// Guards, all required:
//  - FREEAPI_DESKTOP=1: only the desktop embedder sets it; web/Docker installs
//    keep their login.
//  - Loopback socket with no remote forwarded hop (isLocalRequest), so LAN
//    access mode and a local reverse proxy never hand out sessions.
//  - A localhost Host header: a DNS-rebinding page (evil.example resolving to
//    127.0.0.1) is same-origin to the browser but still sends its own name.
//  - Not cross-site: another site's page can fire a request at 127.0.0.1, and
//    Sec-Fetch-Site / Origin say so.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isCrossSite(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return true;
    }
    if (!LOCAL_HOSTNAMES.has(originHost)) return true;
  }
  return false;
}

export function desktopSignInAllowed(req: Request): boolean {
  if (process.env.FREEAPI_DESKTOP !== '1') return false;
  if (!isLocalRequest(req)) return false;
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTNAMES.has(host)) return false;
  return !isCrossSite(req);
}

// Has the dashboard been set up yet, and is this caller authenticated?
// `desktop` tells the dashboard it can fetch a session instead of showing the
// sign-in form.
authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  res.json({
    needsSetup: userCount() === 0,
    authenticated: !!session,
    email: session?.email ?? null,
    desktop: desktopSignInAllowed(req),
  });
});

authRouter.post('/desktop-session', (req: Request, res: Response) => {
  if (!desktopSignInAllowed(req)) {
    res.status(403).json({ error: { message: 'Desktop sign-in is only available on this computer.', type: 'desktop_signin_forbidden' } });
    return;
  }
  res.json({ token: desktopSessionToken() });
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
  if (!isLocalRequest(req) && !setupCodeMatches((req.body ?? {}).setupCode)) {
    res.status(403).json({
      error: {
        message: 'A setup code is required to create the first account from a remote device. ' +
          'Check the server logs for the code, or open the dashboard from a browser on the machine running FreeLLMAPI.',
        type: 'setup_code_required',
      },
    });
    return;
  }

  const parsed = signupSchema.safeParse(req.body);
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
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  const retryAfterSec = lockoutRetryAfterSec(email, req.ip);
  if (retryAfterSec > 0) {
    // RFC 6585: a 429 must say when the client may return. The whole gateway
    // already does this (proxy limiter, exhaustion Retry-After, monthly budget
    // cap); the dashboard's own lockout was the one 429 that didn't.
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: { message: 'Too many attempts. Wait 15 minutes or restart the app.', type: 'rate_limit_error' } });
    return;
  }

  const user = verifyCredentials(email, password);
  if (!user) {
    recordFailure(email, req.ip);
    // Same message whether the email exists or not — don't leak which.
    res.status(401).json({ error: { message: 'Invalid email or password', type: 'authentication_error' } });
    return;
  }

  clearFailures(email, req.ip);
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

// Change email (requires active session + current password)
const changeEmailSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newEmail: z.string().email('A valid email is required'),
});

authRouter.post('/change-email', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  const parsed = changeEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const ok = updateEmail(session.userId, parsed.data.currentPassword, parsed.data.newEmail);
    if (!ok) {
      const attempts = (failedPasswordAttempts.get(session.userId) || 0) + 1;
      if (attempts >= 3) {
        deleteSession(bearer(req));
        failedPasswordAttempts.delete(session.userId);
        res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
        return;
      }
      failedPasswordAttempts.set(session.userId, attempts);
      res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
      return;
    }
    failedPasswordAttempts.delete(session.userId);
    res.json({ success: true, email: parsed.data.newEmail.trim().toLowerCase() });
  } catch (err: any) {
    if (err.code === 'email_taken') {
      res.status(409).json({ error: { message: err.message, type: 'email_taken' } });
    } else {
      throw err;
    }
  }
});

// Change password (requires active session + current password)
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

authRouter.post('/change-password', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const ok = updatePassword(session.userId, parsed.data.currentPassword, parsed.data.newPassword);
  if (!ok) {
    const attempts = (failedPasswordAttempts.get(session.userId) || 0) + 1;
    if (attempts >= 3) {
      deleteSession(bearer(req));
      failedPasswordAttempts.delete(session.userId);
      res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
      return;
    }
    failedPasswordAttempts.set(session.userId, attempts);
    res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
    return;
  }
  failedPasswordAttempts.delete(session.userId);
  res.json({ success: true });
});

// Forgot password: log the reset code (a live one is kept, see reset-code.ts).
// The cooldown is per client IP: one shared stamp let any anonymous caller 429
// the operator indefinitely.
const RESET_CODE_MIN_INTERVAL_MS = 10_000;
const lastResetCodeAt = new Map<string, number>();
authRouter.post('/forgot-password', (req: Request, res: Response) => {
  // Always respond 200 regardless of account existence to avoid user enumeration.
  if (userCount() === 0) {
    res.json({ success: true });
    return;
  }
  const now = Date.now();
  const client = req.ip ?? '';
  const last = lastResetCodeAt.get(client) ?? 0;
  if (now - last < RESET_CODE_MIN_INTERVAL_MS) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((RESET_CODE_MIN_INTERVAL_MS - (now - last)) / 1000))));
    res.status(429).json({ error: { message: 'Too many reset-code requests. Try again later.', type: 'rate_limit_error' } });
    return;
  }
  lastResetCodeAt.set(client, now);
  if (lastResetCodeAt.size > MAX_TRACKED_EMAILS) {
    for (const [ip, at] of lastResetCodeAt) if (now - at >= RESET_CODE_MIN_INTERVAL_MS) lastResetCodeAt.delete(ip);
  }
  generateResetCode(accountEmail());
  res.json({ success: true });
});

// Reset password: accept the logged code + new password
const resetPasswordSchema = z.object({
  resetCode: z.string().min(1, 'Reset code is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

authRouter.post('/reset-password', (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  if (!resetCodeMatches(parsed.data.resetCode)) {
    res.status(403).json({ error: { message: 'Invalid or expired reset code', type: 'authentication_error' } });
    return;
  }
  const user = resetUserPassword(parsed.data.newPassword);
  if (!user) {
    res.status(404).json({ error: { message: 'No account found', type: 'not_found' } });
    return;
  }
  clearResetCode();
  clearAccountLockouts(user.email);
  // Sign the operator straight in: the code already proved they control the
  // install, and sending them back to a login form that needs an email they
  // may not remember left them locked out after a successful reset (#1477).
  const token = createSession(user.userId);
  res.json({ success: true, token, email: user.email });
});
