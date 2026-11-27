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
  recordReauthFailure,
  clearReauthFailures,
  hashSessionToken,
  sessionReauthenticatedUntilMs,
} from '../services/auth.js';
import {
  OIDC_TX_COOKIE_NAME,
  OidcFlowError,
  completeOidcCallback,
  consumeOidcExchangeCode,
  getOidcEndSessionUrl,
  getPublicOidcStatus,
  isPasswordLoginDisabled,
  startOidcAuthorization,
} from '../services/oidc.js';
import { setupCodeMatches, clearSetupCode } from '../lib/setup-code.js';
import { isLoopbackRequest } from '../lib/loopback.js';
import { generateResetCode, resetCodeMatches, clearResetCode } from '../lib/reset-code.js';

export const authRouter = Router();

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
// Simple in-memory per-email limiter. A local single-user tool doesn't need a
// distributed store; this just blunts online password guessing.
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
// Seconds until the per-email lockout lifts (0 when not locked). The 429
// carries this as Retry-After so a client (or a scripted login retry loop)
// backs off for the ACTUAL remaining time instead of the worst-case 15 min.
function lockoutRetryAfterSec(email: string, now = Date.now()): number {
  const a = attempts.get(throttleKey(email));
  if (!a || a.lockedUntil <= now) return 0;
  return Math.max(1, Math.ceil((a.lockedUntil - now) / 1000));
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
// grant locality, but it can withdraw it — the nearest proxy's hop, which is
// the right-most one, because callers control everything to its left.
const isLoopbackRemote = (req: Request): boolean => isLoopbackRequest(req);

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
//  - Loopback socket with no remote forwarded hop (isLoopbackRemote), so LAN
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
  if (!isLoopbackRemote(req)) return false;
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTNAMES.has(host)) return false;
  return !isCrossSite(req);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function requestOrigin(req: Request): string {
  const proto = req.protocol === 'https' ? 'https' : 'http';
  const host = req.get('host') || 'localhost:3001';
  return `${proto}://${host}`;
}

function formatOidcCookie(value: string, secure: boolean, maxAgeSec: number): string {
  const parts = [
    `${OIDC_TX_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/api/auth/oidc',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// Has the dashboard been set up yet, and is this caller authenticated?
// `desktop` tells the dashboard it can fetch a session instead of showing the
// sign-in form.
authRouter.get('/status', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  const oidc = getPublicOidcStatus();
  res.json({
    needsSetup: userCount() === 0,
    authenticated: !!session,
    email: session?.email ?? null,
    desktop: desktopSignInAllowed(req),
    ...(session ? {
      authSource: session.authSource,
      hasLocalPassword: session.hasLocalPassword,
      reauthenticatedUntilMs: sessionReauthenticatedUntilMs(session),
    } : {}),
    ...(oidc ? { oidc } : {}),
  });
});

// ── OIDC dashboard sign-in (#2008) ────────────────────────────────────────
authRouter.get('/oidc/login', async (req: Request, res: Response) => {
  try {
    const origin = requestOrigin(req);
    const { authorizeUrl, cookieValue } = await startOidcAuthorization({
      derivedOrigin: origin,
      purpose: 'login',
      returnPath: typeof req.query.returnTo === 'string' ? req.query.returnTo : '/',
    });
    res.setHeader('Set-Cookie', formatOidcCookie(cookieValue, req.protocol === 'https', 300));
    res.redirect(302, authorizeUrl);
  } catch (err) {
    const code = err instanceof OidcFlowError ? err.code : 'provider_error';
    if (code === 'not_configured') {
      res.status(404).json({ error: { message: 'OIDC is not configured.', type: 'oidc_not_configured' } });
      return;
    }
    console.warn(`[OIDC] Login start failed: ${err instanceof Error ? err.message : err}`);
    res.redirect(302, `/#oidc_error=${encodeURIComponent(code)}`);
  }
});

authRouter.post('/oidc/reauth/start', async (req: Request, res: Response) => {
  const token = bearer(req);
  const session = validateSession(token);
  if (!session || !token) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  if (session.authSource !== 'oidc') {
    res.status(400).json({ error: { message: 'Current session is not an OIDC session.', type: 'invalid_request' } });
    return;
  }
  try {
    const origin = requestOrigin(req);
    const returnPath = typeof req.body?.returnPath === 'string' ? req.body.returnPath : '/keys';
    const { authorizeUrl, cookieValue } = await startOidcAuthorization({
      derivedOrigin: origin,
      purpose: 'reauth',
      sessionTokenHash: hashSessionToken(token),
      expectedUserId: session.userId,
      returnPath,
    });
    res.setHeader('Set-Cookie', formatOidcCookie(cookieValue, req.protocol === 'https', 300));
    res.json({ authorizeUrl });
  } catch (err) {
    const status = err instanceof OidcFlowError && err.code === 'not_configured' ? 404 : 502;
    res.status(status).json({
      error: {
        message: err instanceof Error ? err.message : 'Could not start OIDC re-authentication.',
        type: err instanceof OidcFlowError ? err.code : 'oidc_error',
      },
    });
  }
});

authRouter.get('/oidc/callback', async (req: Request, res: Response) => {
  const secure = req.protocol === 'https';
  res.setHeader('Set-Cookie', formatOidcCookie('', secure, 0));

  if (typeof req.query.error === 'string' && req.query.error) {
    console.warn(`[OIDC] Provider returned error=${req.query.error}`);
    res.redirect(302, '/#oidc_error=provider_error');
    return;
  }

  try {
    const callbackUrl = new URL(req.originalUrl, requestOrigin(req));
    const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined;
    const cookieValue = parseCookie(req.headers.cookie, OIDC_TX_COOKIE_NAME);
    const result = await completeOidcCallback({ callbackUrl, stateParam, cookieValue });

    if (result.purpose === 'reauth') {
      res.redirect(302, `${result.returnPath}#oidc_reauth=ok`);
      return;
    }
    res.redirect(302, `${result.returnPath}#oidc_code=${encodeURIComponent(result.exchangeCode)}`);
  } catch (err) {
    const code = err instanceof OidcFlowError ? err.code : 'exchange_failed';
    console.warn(`[OIDC] Callback failed (${code}): ${err instanceof Error ? err.message : err}`);
    res.redirect(302, `/#oidc_error=${encodeURIComponent(code)}`);
  }
});

const oidcExchangeSchema = z.object({
  code: z.string().min(1, 'Exchange code is required'),
});

authRouter.post('/oidc/exchange', (req: Request, res: Response) => {
  const parsed = oidcExchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  const grant = consumeOidcExchangeCode(parsed.data.code);
  if (!grant) {
    res.status(401).json({ error: { message: 'Invalid or expired OIDC exchange code', type: 'authentication_error' } });
    return;
  }
  res.json({ token: grant.token, email: grant.email });
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

  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  clearSetupCode(); // one-time: the dashboard is now claimed
  const token = createSession(user.userId);
  res.status(201).json({ token, email: user.email });
});

authRouter.post('/login', (req: Request, res: Response) => {
  if (isPasswordLoginDisabled()) {
    res.status(403).json({
      error: {
        message: 'Password sign-in is disabled; sign in with SSO.',
        type: 'password_login_disabled',
      },
    });
    return;
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  const { email, password } = parsed.data;

  if (isLockedOut(email)) {
    // RFC 6585: a 429 must say when the client may return. The whole gateway
    // already does this (proxy limiter, exhaustion Retry-After, monthly budget
    // cap); the dashboard's own lockout was the one 429 that didn't.
    res.setHeader('Retry-After', String(lockoutRetryAfterSec(email)));
    res.status(429).json({ error: { message: 'Too many attempts. Wait 15 minutes or restart the app.', type: 'rate_limit_error' } });
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

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = bearer(req);
  const session = validateSession(token);
  deleteSession(token);
  const endSessionUrl = session?.authSource === 'oidc' ? await getOidcEndSessionUrl() : null;
  res.json({ success: true, ...(endSessionUrl ? { endSessionUrl } : {}) });
});

authRouter.get('/me', (req: Request, res: Response) => {
  const session = validateSession(bearer(req));
  if (!session) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  res.json({
    email: session.email,
    authSource: session.authSource,
    hasLocalPassword: session.hasLocalPassword,
    reauthenticatedUntilMs: sessionReauthenticatedUntilMs(session),
  });
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
  if (!session.hasLocalPassword) {
    res.status(403).json({ error: { message: 'This account signs in with SSO and has no local password.', type: 'oidc_account_no_password' } });
    return;
  }
  const parsed = changeEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const ok = updateEmail(session.userId, parsed.data.currentPassword, parsed.data.newEmail);
    if (!ok) {
      if (recordReauthFailure(session.userId, bearer(req))) {
        res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
        return;
      }
      res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
      return;
    }
    clearReauthFailures(session.userId);
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
  if (!session.hasLocalPassword) {
    res.status(403).json({ error: { message: 'This account signs in with SSO and has no local password.', type: 'oidc_account_no_password' } });
    return;
  }
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
    return;
  }
  const ok = updatePassword(session.userId, parsed.data.currentPassword, parsed.data.newPassword);
  if (!ok) {
    if (recordReauthFailure(session.userId, bearer(req))) {
      res.status(401).json({ error: { message: 'Too many incorrect attempts. You have been signed out.', type: 'authentication_error' } });
      return;
    }
    res.status(403).json({ error: { message: 'Current password is incorrect', type: 'invalid_password' } });
    return;
  }
  clearReauthFailures(session.userId);
  res.json({ success: true });
});

// Forgot password: mint a reset code and log it
const RESET_CODE_MIN_INTERVAL_MS = 10_000;
let lastResetCodeAt = 0;
authRouter.post('/forgot-password', (_req: Request, res: Response) => {
  // Always respond 200 regardless of account existence to avoid user enumeration.
  if (userCount() === 0) {
    res.json({ success: true });
    return;
  }
  const now = Date.now();
  if (now - lastResetCodeAt < RESET_CODE_MIN_INTERVAL_MS) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((RESET_CODE_MIN_INTERVAL_MS - (now - lastResetCodeAt)) / 1000))));
    res.status(429).json({ error: { message: 'Too many reset-code requests. Try again later.', type: 'rate_limit_error' } });
    return;
  }
  lastResetCodeAt = now;
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
    res.status(400).json({ error: { message: parsed.error.issues.map(e => e.message).join(', ') } });
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
  // Sign the operator straight in: the code already proved they control the
  // install, and sending them back to a login form that needs an email they
  // may not remember left them locked out after a successful reset (#1477).
  const token = createSession(user.userId);
  res.json({ success: true, token, email: user.email });
});
