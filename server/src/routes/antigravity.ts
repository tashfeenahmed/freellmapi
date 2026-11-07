import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
import {
  buildAuthUrl,
  exchangeCode,
  fetchUserEmail,
  newState,
  newVerifier,
} from '../lib/antigravity-auth.js';
import { AntigravityProvider } from '../providers/antigravity.js';

export const antigravityRouter = Router();

antigravityRouter.get('/auth-url', (_req: Request, res: Response) => {
  const state = newState();
  const verifier = newVerifier();
  const { url } = buildAuthUrl(state, verifier);
  // The verifier is returned (never logged) so the dashboard holds it for
  // the exchange call; Google never sees it, only the derived challenge.
  res.json({ url, state, verifier });
});

const exchangeSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(500).optional(),
  verifier: z.string().min(1).max(2000),
  label: z.string().max(120).optional(),
});

antigravityRouter.post('/exchange', async (req: Request, res: Response) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { verifier, label } = parsed.data;
  let code = parsed.data.code.trim();
  if (code.includes('code=')) {
    try {
      const u = new URL(code.startsWith('http') ? code : `http://localhost/${code}`);
      const c = u.searchParams.get('code');
      if (c) code = c;
    } catch {}
  }
  let tokens;
  try {
    tokens = await exchangeCode(code, verifier);
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error).message } });
    return;
  }
  const email = await fetchUserEmail(tokens.token);
  // Discover the Cloud project now so the stored blob is complete; without
  // it every chat call would pay a discovery round trip (and fail loudly
  // instead of here if discovery is down).
  let projectId: string | undefined;
  try {
    projectId = await new AntigravityProvider().discoverProject(tokens.token);
  } catch {
    // Token is live (exchange + email succeeded); project resolves lazily
    // per request. Store what we have.
  }
  const blob = JSON.stringify({ token: tokens.token, refresh: tokens.refresh, projectId, expiry: tokens.expiry, email });
  const { encrypted, iv, authTag } = encrypt(blob);
  const db = getDb();
  const info = db.prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('antigravity', ?, ?, ?, ?, 'unknown', 1)",
  ).run(label ?? email ?? 'Google account', encrypted, iv, authTag);
  db.prepare("UPDATE models SET enabled = 1 WHERE platform = 'antigravity'").run();
  res.status(201).json({ id: Number(info.lastInsertRowid), platform: 'antigravity', enabled: true });
});
