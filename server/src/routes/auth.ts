import { Router } from 'express';
import { z } from 'zod';
import {
  countUsers,
  getDb,
  getUserByUsername,
  updateLastLogin,
} from '../db/index.js';
import {
  dummyPasswordHashForTiming,
  hashPassword,
  validatePasswordPolicy,
  verifyPassword,
} from '../lib/passwords.js';
import { normalizeUserIdentifier, validateUsername } from '@freellmapi/shared/validate-username.js';

const FAIL_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

const setupBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  confirmPassword: z.string().min(1),
});

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  res.json({
    setupRequired: countUsers() === 0,
    authenticated: req.session.userId != null,
  });
});

authRouter.get('/me', (req, res) => {
  if (req.session.userId == null) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    },
  });
});

authRouter.post('/setup', async (req, res, next) => {
  try {
    const parsed = setupBody.safeParse(req.body);
    if (!parsed.success) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: 'Invalid body', type: 'validation_error' } });
      return;
    }
    const { username, password, confirmPassword } = parsed.data;
    const uErr = validateUsername(username);
    if (uErr) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: uErr, type: 'validation_error' } });
      return;
    }
    const pErr = validatePasswordPolicy(password);
    if (pErr) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: pErr, type: 'validation_error' } });
      return;
    }
    if (password !== confirmPassword) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: 'Passwords do not match', type: 'validation_error' } });
      return;
    }

    const loginId = normalizeUserIdentifier(username);
    const db = getDb();
    const passwordHash = await hashPassword(password);

    const outcome = db.transaction(() => {
      const c = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
      if (c > 0) {
        return { kind: 'already_done' as const };
      }
      const r = db
        .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(loginId, passwordHash, 'superadmin');
      return {
        kind: 'ok' as const,
        userId: Number(r.lastInsertRowid),
        username: loginId,
        role: 'superadmin' as const,
      };
    })();

    if (outcome.kind === 'already_done') {
      res.status(409).json({ error: { message: 'Setup already completed', type: 'setup_already_done' } });
      return;
    }

    req.session.userId = outcome.userId;
    req.session.username = outcome.username;
    req.session.role = outcome.role;
    req.session.loggedInAt = Date.now();
    await req.session.save();

    res.status(201).json({
      user: { id: outcome.userId, username: outcome.username, role: outcome.role },
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: 'Invalid body', type: 'validation_error' } });
      return;
    }
    const { username, password } = parsed.data;
    const uErrLogin = validateUsername(username);
    if (uErrLogin) {
      await sleep(FAIL_DELAY_MS);
      res.status(400).json({ error: { message: uErrLogin, type: 'validation_error' } });
      return;
    }
    const row = getUserByUsername(normalizeUserIdentifier(username));
    const hashToCompare = row?.password_hash ?? dummyPasswordHashForTiming();
    const passwordOk = await verifyPassword(password, hashToCompare);
    if (!row || !passwordOk) {
      await sleep(FAIL_DELAY_MS);
      res.status(401).json({ error: { message: 'Invalid username or password', type: 'invalid_credentials' } });
      return;
    }

    updateLastLogin(row.id);
    req.session.userId = row.id;
    req.session.username = row.username;
    req.session.role = row.role;
    req.session.loggedInAt = Date.now();
    await req.session.save();

    res.json({ user: { id: row.id, username: row.username, role: row.role } });
  } catch (e) {
    next(e);
  }
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});
