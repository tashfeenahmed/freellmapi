/**
 * GitHub Copilot device-flow endpoints for the dashboard.
 *
 * Two endpoints under /api/keys/copilot:
 *   POST /start  → kicks off Step 1 of the device flow, stores the
 *                  device_code server-side keyed by a session UUID,
 *                  returns the user-facing code + verification URL.
 *   POST /poll   → takes the session UUID and makes one access-token
 *                  POST. On success, encrypts the gho_ token and
 *                  inserts it into api_keys with platform=github-copilot
 *                  (same shape the CLI script produces).
 *
 * Sessions live in memory only. They expire when GitHub's
 * `expires_in` window passes (also enforced server-side) so we don't
 * leak device_codes long after the user walks away from the modal.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';
import {
  requestDeviceCode,
  attemptTokenExchange,
  type PollResult,
} from '../lib/copilot-auth.js';

export const copilotFlowRouter = Router();

interface Session {
  deviceCode: string;
  expiresAt: number;
  /** Set to true after a successful token has been persisted so the
   *  next poll returns success again without re-inserting. */
  resolvedKeyId?: number;
  resolvedMasked?: string;
}

// Module-scoped: per-process. The dashboard is single-instance and
// these sessions live ~15 min max — no need for a shared store.
const sessions = new Map<string, Session>();

// Periodically prune expired sessions so the map can't grow without
// bound if users start logins and bail. 5 min sweep is fine.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref();

copilotFlowRouter.post('/start', async (_req: Request, res: Response) => {
  try {
    const dc = await requestDeviceCode();
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      deviceCode: dc.device_code,
      expiresAt: Date.now() + dc.expires_in * 1000,
    });
    res.json({
      sessionId,
      userCode: dc.user_code,
      verificationUri: dc.verification_uri,
      interval: dc.interval,
      expiresIn: dc.expires_in,
    });
  } catch (err: any) {
    res.status(502).json({
      error: {
        message: `Failed to start device flow: ${err?.message ?? err}`,
        type: 'device_flow_error',
      },
    });
  }
});

copilotFlowRouter.post('/poll', async (req: Request, res: Response) => {
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
  if (!sessionId) {
    res.status(400).json({ error: { message: 'sessionId is required', type: 'invalid_request_error' } });
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: { message: 'Session not found or expired. Restart the login.', type: 'session_not_found' } });
    return;
  }

  // If the same session polls again after success, return the previous
  // result without inserting a second row. Browsers can fire an
  // overlapping poll while the modal closes.
  if (session.resolvedKeyId !== undefined) {
    res.json({ status: 'success', id: session.resolvedKeyId, masked: session.resolvedMasked });
    return;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    res.json({ status: 'error', message: 'Device code expired before authorization. Restart the login.' });
    return;
  }

  let result: PollResult;
  try {
    result = await attemptTokenExchange(session.deviceCode);
  } catch (err: any) {
    res.json({ status: 'error', message: `OAuth poll failed: ${err?.message ?? err}` });
    return;
  }

  if (result.status === 'success') {
    const label = `dashboard ${new Date().toISOString().slice(0, 10)}`;
    const { encrypted, iv, authTag } = encrypt(result.accessToken);
    const ins = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('github-copilot', ?, ?, ?, ?, 'unknown', 1)
    `).run(label, encrypted, iv, authTag);
    const id = Number(ins.lastInsertRowid);
    const masked = maskKey(result.accessToken);
    session.resolvedKeyId = id;
    session.resolvedMasked = masked;
    res.json({ status: 'success', id, masked });
    return;
  }

  // pending | slow_down | error — pass straight through.
  res.json(result);
});
