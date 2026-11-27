import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #2020: GET /api/keys returns each key's upstream API request URL (`apiUrl`)
// so the dashboard can offer direct URL copy beside "Copy full key", without
// altering `baseUrl` semantics (custom endpoints only) or leaking credentials.

let app: Express;
let token: string;

async function listKeys() {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  server.close();
  return { status: res.status, body: body as Array<{ platform: string; baseUrl: string | null; apiUrl: string | null }> };
}

function insertKey(platform: string, rawKey: string, baseUrl: string | null = null) {
  const { encrypted, iv, authTag } = encrypt(rawKey);
  getDb().prepare(
    'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(platform, `${platform} test`, encrypted, iv, authTag, baseUrl);
}

describe('GET /api/keys apiUrl (#2020)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('exposes the upstream API request URL for built-in and custom keys without leaking Cloudflare account IDs', async () => {
    insertKey('groq', 'gsk_test_groq_key');
    insertKey('google', 'AIza_test_google_key');
    insertKey('custom', 'sk-custom-key', 'http://127.0.0.1:8080/v1');
    insertKey('cloudflare', 'secret-account-id:secret-cf-token');

    const { status, body } = await listKeys();
    expect(status).toBe(200);

    const byPlatform = new Map(body.map(k => [k.platform, k]));
    expect(byPlatform.get('groq')?.apiUrl).toBe('https://api.groq.com/openai/v1');
    expect(byPlatform.get('groq')?.baseUrl).toBeNull();

    expect(byPlatform.get('google')?.apiUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(byPlatform.get('google')?.baseUrl).toBeNull();

    expect(byPlatform.get('custom')?.apiUrl).toBe('http://127.0.0.1:8080/v1');
    expect(byPlatform.get('custom')?.baseUrl).toBe('http://127.0.0.1:8080/v1');

    // Cloudflare embeds accountId in its URL path — never expose it in the un-reauthed key list.
    expect(byPlatform.get('cloudflare')?.apiUrl).toBeNull();
  });
});

describe('provider.getApiBaseUrl (#2020)', () => {
  it('never puts credentials, query strings or the key itself into a built-in URL', async () => {
    const { getAllProviders } = await import('../../providers/index.js');
    const sentinel = 'SENTINEL-acct-123:SENTINEL-token-456';
    const withUrl = new Set<string>();
    for (const provider of getAllProviders()) {
      if (provider.platform === 'custom') continue;
      for (const key of [sentinel, 'no-key', undefined]) {
        const url = provider.getApiBaseUrl(key);
        if (url === null) continue;
        expect(url, provider.platform).not.toContain('SENTINEL');
        const parsed = new URL(url);
        expect(parsed.protocol, provider.platform).toBe('https:');
        expect(parsed.username + parsed.password, provider.platform).toBe('');
        expect(parsed.search, provider.platform).toBe('');
        withUrl.add(provider.platform);
      }
    }
    expect(withUrl.size).toBeGreaterThan(50);
    expect(getAllProviders().find(p => p.platform === 'cloudflare')?.getApiBaseUrl(sentinel)).toBeNull();
  });
});
