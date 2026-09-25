import crypto from 'crypto';
import { getPostgresPool } from '../db/postgres.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

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

export async function userCount(): Promise<number> {
  try {
    const pool = getPostgresPool();
    const res = await pool.query('SELECT COUNT(*) AS c FROM users');
    return parseInt(res.rows[0]?.c || '0', 10);
  } catch {
    return 0;
  }
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export async function createUser(email: string, password: string): Promise<SessionUser> {
  const pool = getPostgresPool();
  const normalized = normalizeEmail(email);

  try {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [normalized, hashPassword(password)]
    );
    return { userId: result.rows[0].id, email: result.rows[0].email };
  } catch (err: any) {
    if (err?.code === '23505' || err?.message?.includes('duplicate') || err?.message?.includes('UNIQUE')) {
      const e = new Error('An account with that email already exists') as any;
      e.code = 'email_taken';
      throw e;
    }
    throw err;
  }
}

/** Verify credentials. Returns the user on success, null on failure. */
export async function verifyCredentials(email: string, password: string): Promise<SessionUser | null> {
  const pool = getPostgresPool();
  const res = await pool.query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [normalizeEmail(email)]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email };
}

/** Mint a session and return the raw token (only the hash is persisted). */
export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const pool = getPostgresPool();
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES ($1, $2, $3)',
    [sha256(token), userId, Date.now() + SESSION_TTL_MS]
  );
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export async function validateSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const pool = getPostgresPool();
  const tokenHash = sha256(token);

  const res = await pool.query(
    `SELECT s.user_id, s.expires_at_ms, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );

  const row = res.rows[0];
  if (!row) return null;

  if (Number(row.expires_at_ms) < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return null;
  }

  return { userId: row.user_id, email: row.email };
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const pool = getPostgresPool();
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

/** Update the email of the authenticated user after verifying the current password. */
export async function updateEmail(userId: number, currentPassword: string, newEmail: string): Promise<boolean> {
  const pool = getPostgresPool();
  const res = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const row = res.rows[0];
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;

  const normalized = normalizeEmail(newEmail);
  try {
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [normalized, userId]);
    return true;
  } catch (err: any) {
    if (err?.code === '23505' || err?.message?.includes('duplicate') || err?.message?.includes('UNIQUE')) {
      const e = new Error('An account with that email already exists') as any;
      e.code = 'email_taken';
      throw e;
    }
    throw err;
  }
}

/** Update the password of the authenticated user after verifying the current one. */
export async function updatePassword(userId: number, currentPassword: string, newPassword: string): Promise<boolean> {
  const pool = getPostgresPool();
  const res = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const row = res.rows[0];
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), userId]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return true;
}

export async function resetUserPassword(newPassword: string): Promise<boolean> {
  const pool = getPostgresPool();
  const res = await pool.query('SELECT id FROM users LIMIT 1');
  const row = res.rows[0];
  if (!row) return false;

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), row.id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
  return true;
}
