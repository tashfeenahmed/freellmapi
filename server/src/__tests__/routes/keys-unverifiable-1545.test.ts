import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { checkKeyHealth, markKeyHealthyFromRequest, visibleHealthError } from '../../services/health.js';

// #1545: a Free.ai key showed "unchecked" with a RED error line, "Free.ai has
// no verified credential-validation endpoint; key validity is unknown (no
// quota spent)". The message came from a probe an older release still sent;
// Free.ai has since been marked as never probed, but the stored message kept
// reaching the dashboard (a disabled key is never in a health pass to clear
// it). Unknown validity is not an error: the API must not report it as one,
// and must say why the key is unchecked so the dashboard can explain it.

let dashToken = '';
const STALE = 'Free.ai has no verified credential-validation endpoint; key validity is unknown (no quota spent)';

async function request(app: Express, method: string, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function seedKey(platform: string, opts: { enabled?: 0 | 1; status?: string; lastError?: string | null } = {}): number {
  const enc = encrypt(`${platform}-key-${Math.random().toString(36).slice(2)}`);
  const res = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 day'))
  `).run(platform, platform, enc.encrypted, enc.iv, enc.authTag, opts.enabled ?? 1, opts.status ?? 'unknown', opts.lastError ?? null);
  return Number(res.lastInsertRowid);
}

const row = (id: number) =>
  getDb().prepare('SELECT status, last_health_error FROM api_keys WHERE id = ?').get(id) as { status: string; last_health_error: string | null };

describe('a key whose provider cannot be checked without spending quota (#1545)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('the key list reports no error and says why the key is unchecked', async () => {
    const freeai = seedKey('freeai', { lastError: STALE });
    const disabled = seedKey('freeai', { enabled: 0, lastError: STALE });
    const llmtr = seedKey('llmtr', { lastError: 'LLMTR rejected the key-validation probe itself' });
    const groq = seedKey('groq', { status: 'invalid', lastError: 'Groq rejected the API key' });

    const { status, body } = await request(app, 'GET', '/api/keys');
    expect(status).toBe(200);
    const byId = new Map(body.map((k: any) => [k.id, k]));

    expect(byId.get(freeai)).toMatchObject({ status: 'unknown', autoHealthCheck: false, keyCheckUnavailable: 'quota', lastHealthError: null });
    expect(byId.get(disabled)).toMatchObject({ enabled: false, keyCheckUnavailable: 'quota', lastHealthError: null });
    expect(byId.get(llmtr)).toMatchObject({ autoHealthCheck: false, keyCheckUnavailable: 'forbidden', lastHealthError: null });
    // A real probe failure on a probed provider is still an error.
    expect(byId.get(groq)).toMatchObject({ autoHealthCheck: true, lastHealthError: 'Groq rejected the API key' });
    expect(byId.get(groq)).not.toHaveProperty('keyCheckUnavailable');
  });

  it('the health endpoint the Keys page polls drops the stale error too', async () => {
    const freeai = seedKey('freeai', { enabled: 0, lastError: STALE });
    const groq = seedKey('groq', { status: 'invalid', lastError: 'Groq rejected the API key' });

    const { body } = await request(app, 'GET', '/api/health');
    const byId = new Map(body.keys.map((k: any) => [k.id, k]));
    expect(byId.get(freeai)).toMatchObject({ lastHealthError: null });
    expect(byId.get(groq)).toMatchObject({ lastHealthError: 'Groq rejected the API key' });
  });

  it('every never-probed provider is covered, with no probe sent by "Check now"', async () => {
    for (const platform of ['freeai', 'novai', 'freemodel', 'freeinference', 'kiosapi', 'iteracompute']) {
      expect(visibleHealthError(platform, null, 'no verified credential-validation endpoint')).toBeNull();
      const id = seedKey(platform, { lastError: 'old probe error' });
      expect(await checkKeyHealth(id)).toBe('unknown');
      expect(row(id)).toEqual({ status: 'unknown', last_health_error: null });
    }
    expect(visibleHealthError('groq', null, 'Groq rejected the API key')).toBe('Groq rejected the API key');
  });

  it('the unchecked key still routes, and turns healthy on its first served request', () => {
    const id = seedKey('freeai', { lastError: STALE });
    const pool = getDb().prepare(
      "SELECT id FROM api_keys WHERE platform = 'freeai' AND enabled = 1 AND status IN ('healthy', 'unknown')",
    ).all() as { id: number }[];
    expect(pool.map(r => r.id)).toContain(id);

    markKeyHealthyFromRequest(id);
    expect(row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });
});
