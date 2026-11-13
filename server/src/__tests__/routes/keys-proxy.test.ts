import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { decryptProxyUrl } from '../../lib/key-proxy.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const PROXY_WITH_CREDS = 'socks5h://alice:hunter2@proxy.internal:1080';

// Per-key proxy override (#590). The URL is a credential in its own right —
// `user:pass@` is the norm for commercial proxies — so it is stored with the
// same AES-256-GCM treatment as the API key on the row, never echoed back in
// the clear, and only accepted on schemes the proxy layer can dispatch through.
describe('Keys API — per-key proxy override (#590)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function insertKey(): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
    return Number(result.lastInsertRowid);
  }

  const proxyRow = (id: number) => getDb().prepare(
    'SELECT proxy_encrypted, proxy_iv, proxy_auth_tag FROM api_keys WHERE id = ?',
  ).get(id) as { proxy_encrypted: string | null; proxy_iv: string | null; proxy_auth_tag: string | null };

  describe('POST /api/keys', () => {
    it('stores the proxy URL encrypted, never as plaintext', async () => {
      const post = await request(app, 'POST', '/api/keys', {
        platform: 'groq', key: 'sk-groq-1', proxyUrl: PROXY_WITH_CREDS,
      });
      expect(post.status).toBe(201);

      const row = proxyRow(Number(post.body.id));
      expect(row.proxy_encrypted).toBeTruthy();
      expect(row.proxy_iv).toBeTruthy();
      expect(row.proxy_auth_tag).toBeTruthy();
      // Nothing recognisable survives in the column: not the password, not the
      // username, not the host, not even the scheme. Every string here must
      // contain at least one non-hex character: the column is lowercase hex,
      // so a pure-digit fragment like the port "1080" can appear in the
      // ciphertext by chance (~1 in 700 runs) without being a leak — asserting
      // it made this test flaky (CI reroll on PR #1601).
      const stored = String(row.proxy_encrypted);
      for (const secret of ['hunter2', 'alice', 'proxy.internal', 'socks5h']) {
        expect(stored).not.toContain(secret);
      }
      // ...and it round-trips.
      expect(decryptProxyUrl(row)).toBe(PROXY_WITH_CREDS);
    });

    it('answers with the password masked, not the URL it was given', async () => {
      const post = await request(app, 'POST', '/api/keys', {
        platform: 'groq', key: 'sk-groq-1', proxyUrl: PROXY_WITH_CREDS,
      });
      expect(post.body.maskedProxyUrl).toBe('socks5h://alice:***@proxy.internal:1080');
      expect(JSON.stringify(post.body)).not.toContain('hunter2');
    });

    it('leaves the columns NULL when no override is given', async () => {
      const post = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'sk-groq-1' });
      expect(post.status).toBe(201);
      expect(post.body.maskedProxyUrl).toBe('');
      const row = proxyRow(Number(post.body.id));
      expect(row.proxy_encrypted).toBeNull();
      expect(row.proxy_iv).toBeNull();
      expect(row.proxy_auth_tag).toBeNull();
    });

    it('accepts every scheme the proxy layer can dispatch through', async () => {
      for (const proxyUrl of [
        'http://proxy:8080',
        'https://proxy:8443',
        'socks4://127.0.0.1:1080',
        'socks4a://127.0.0.1:1080',
        'socks5://127.0.0.1:1080',
        'socks5h://user:pass@127.0.0.1:1080',
        '', // explicit "no override"
      ]) {
        const post = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'sk-groq-1', proxyUrl });
        expect(post.status, proxyUrl).toBe(201);
      }
    });

    it('rejects a scheme the proxy layer cannot dispatch through', async () => {
      for (const proxyUrl of ['ftp://proxy:21', 'file:///etc/passwd', 'ws://proxy:8080', 'javascript:alert(1)']) {
        const post = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'sk-groq-1', proxyUrl });
        expect(post.status, proxyUrl).toBe(400);
        expect(post.body.error.message).toMatch(/socks5/);
      }
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 0 });
    });

    it('rejects anything that is not a URL at all', async () => {
      for (const proxyUrl of ['proxy.internal:1080', 'not a url', 'http://', '   ']) {
        const post = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'sk-groq-1', proxyUrl });
        // A whitespace-only value is the "clear it" spelling, so it is legal.
        expect(post.status, proxyUrl).toBe(proxyUrl.trim() === '' ? 201 : 400);
      }
    });
  });

  describe('PATCH /api/keys/:id', () => {
    it('sets an override on an existing key', async () => {
      const id = insertKey();
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: PROXY_WITH_CREDS });
      expect(patch.status).toBe(200);
      expect(patch.body.maskedProxyUrl).toBe('socks5h://alice:***@proxy.internal:1080');
      expect(JSON.stringify(patch.body)).not.toContain('hunter2');
      expect(decryptProxyUrl(proxyRow(id))).toBe(PROXY_WITH_CREDS);
    });

    it("'' clears the override back to NULL", async () => {
      const id = insertKey();
      await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: PROXY_WITH_CREDS });
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: '' });
      expect(patch.status).toBe(200);
      expect(patch.body.maskedProxyUrl).toBe('');
      expect(proxyRow(id)).toEqual({ proxy_encrypted: null, proxy_iv: null, proxy_auth_tag: null });
      expect(decryptProxyUrl(proxyRow(id))).toBe('');
    });

    it('leaves the override alone when only other fields are patched', async () => {
      const id = insertKey();
      await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: PROXY_WITH_CREDS });
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { label: 'renamed' });
      expect(patch.status).toBe(200);
      expect(patch.body.maskedProxyUrl).toBeUndefined();
      expect(decryptProxyUrl(proxyRow(id))).toBe(PROXY_WITH_CREDS);
    });

    it('rejects an invalid override and leaves the stored one untouched', async () => {
      const id = insertKey();
      await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: PROXY_WITH_CREDS });
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: 'ftp://proxy:21' });
      expect(patch.status).toBe(400);
      expect(decryptProxyUrl(proxyRow(id))).toBe(PROXY_WITH_CREDS);
    });

    it('a body naming only proxyUrl satisfies the at-least-one-field rule', async () => {
      const id = insertKey();
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: 'http://proxy:8080' });
      expect(patch.status).toBe(200);
    });
  });

  describe('GET /api/keys', () => {
    it('shows that an override exists without handing the credentials back', async () => {
      const id = insertKey();
      await request(app, 'PATCH', `/api/keys/${id}`, { proxyUrl: PROXY_WITH_CREDS });

      const list = await request(app, 'GET', '/api/keys');
      expect(list.status).toBe(200);
      const key = list.body.find((k: any) => k.id === id);
      expect(key.maskedProxyUrl).toBe('socks5h://alice:***@proxy.internal:1080');
      expect(JSON.stringify(list.body)).not.toContain('hunter2');
    });

    it("reports '' for a key with no override", async () => {
      const id = insertKey();
      const list = await request(app, 'GET', '/api/keys');
      expect(list.body.find((k: any) => k.id === id).maskedProxyUrl).toBe('');
    });
  });
});
