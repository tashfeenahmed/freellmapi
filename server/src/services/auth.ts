import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: number;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** The one spelling of an address the DB is keyed on. Exported so callers that
 *  bucket by email (the login throttle in routes/auth.ts) key on exactly what
 *  verifyCredentials will look up — keying on anything else lets a padded
 *  address authenticate against the real row while landing in its own bucket. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalized, hashPassword(password));
  return { userId: Number(result.lastInsertRowid), email: normalized };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .get(normalizeEmail(email)) as { id: number; email: string; password_hash: string } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email };
}

/** Desktop app only: a session for the install's account, creating the hidden
 *  machine account (`desktop@localhost`, random password nobody knows) on first
 *  run. The desktop window gets this over IPC; a browser tab on the same
 *  machine gets it from POST /api/auth/desktop-session (routes/auth.ts). */
export function desktopSessionToken(): string {
  if (userCount() === 0) {
    createUser('desktop@localhost', crypto.randomBytes(24).toString('hex'));
  }
  const first = getDb().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number };
  return createSession(first.id);
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.user_id, s.expires_at_ms, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token)) as { user_id: number; expires_at_ms: number; email: string } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { userId: row.user_id, email: row.email };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// Wrong-password strikes against a signed-in session, shared by every endpoint
// that re-asks for the dashboard password: change-email, change-password, key
// export and key reveal (#1885). A stolen session token must not be usable as an
// unlimited password oracle, so the third wrong password in a row ends the
// session and the caller has to log in again, where the per-email login
// lockout applies.
export const MAX_REAUTH_STRIKES = 3;
const reauthStrikes = new Map<number, number>();

/** Count a wrong re-entered password. Returns true when this strike ended the
 * session (the token is deleted), false when the caller may retry. */
export function recordReauthFailure(userId: number, token: string | undefined | null): boolean {
  const strikes = (reauthStrikes.get(userId) ?? 0) + 1;
  if (strikes >= MAX_REAUTH_STRIKES) {
    reauthStrikes.delete(userId);
    deleteSession(token);
    return true;
  }
  reauthStrikes.set(userId, strikes);
  return false;
}

export function clearReauthFailures(userId: number): void {
  reauthStrikes.delete(userId);
}

/** Test hook. */
export function resetReauthFailures(): void {
  reauthStrikes.clear();
}

/** Update the email of the authenticated user after verifying the current password. Throws { code: 'email_taken' } on conflict. */
export function updateEmail(userId: number, currentPassword: string, newEmail: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;

  const normalized = normalizeEmail(newEmail);
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalized, userId);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(normalized, userId);
  // Keep sessions alive; the new email will be reflected on the next validateSession call.
  return true;
}

/** Update the password of the authenticated user after verifying the current one. Invalidates all sessions on success. */
export function updatePassword(userId: number, currentPassword: string, newPassword: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return true;
}

/** The single account's email, or null before first-run setup. */
export function accountEmail(): string | null {
  const row = getDb().prepare('SELECT email FROM users LIMIT 1').get() as { email: string } | undefined;
  return row?.email ?? null;
}

/**
 * Reset the password for the single existing user and invalidate all
 * sessions.
 * Returns the user, or null if no user exists.
 */
export function resetUserPassword(newPassword: string): SessionUser | null {
  const db = getDb();
  const row = db.prepare('SELECT id, email FROM users LIMIT 1').get() as { id: number; email: string } | undefined;
  if (!row) return null;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  return { userId: row.id, email: row.email };
}
