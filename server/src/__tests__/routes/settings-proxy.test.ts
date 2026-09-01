import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getSetting, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { applyFetchRelayToken, applyProxyMode, applyProxyUrl } from '../../lib/proxy.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

// PUT /api/settings/proxy is the only place a proxy URL is validated, so the
// scheme allow-list here is what actually decides whether a user can save
// `socks5h://` from the dashboard (#630).
describe('PUT /api/settings/proxy scheme validation', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const name of ['PROXY_MODE', 'PROXY_URL', 'FETCH_RELAY_TOKEN', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
      delete process.env[name];
      delete process.env[name.toLowerCase()];
    }
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  afterAll(() => {
    applyProxyMode('forward');
    applyProxyUrl('');
    applyFetchRelayToken('');
  });

  const accepted = [
    'http://proxy.corp.com:8080',
    'https://proxy.corp.com:8443',
    'socks5://127.0.0.1:1080',
    'socks5h://127.0.0.1:1080',
    'socks4://127.0.0.1:1080',
    'socks4a://127.0.0.1:1080',
  ];

  for (const proxyUrl of accepted) {
    it(`accepts ${proxyUrl}`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl }, token);
      expect(status).toBe(200);
      expect(body.proxyUrl).toBe(proxyUrl);
    });
  }

  it('accepts socks5h with credentials', async () => {
    const proxyUrl = 'socks5h://user:pass@127.0.0.1:1080';
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl }, token);
    expect(status).toBe(200);
    expect(body.proxyUrl).toBe(proxyUrl);
  });

  it('rejects an unsupported scheme', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: 'ftp://proxy:21' }, token);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/socks5h/);
  });

  it('rejects a malformed URL', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: 'not a url' }, token);
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('clears the proxy on an empty string', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { proxyUrl: '' }, token);
    expect(status).toBe(200);
    expect(body.proxyUrl).toBe('');
  });

  it('saves fetch-relay mode with an HTTPS endpoint', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'fetch-relay',
      proxyUrl: 'https://relay.example.workers.dev/secret',
    }, token);
    expect(status).toBe(200);
    expect(body.proxyMode).toBe('fetch-relay');
    expect(body.proxyUrl).toBe('https://relay.example.workers.dev/secret');
  });

  it('stores a Relay token without returning it from the settings API', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'fetch-relay',
      proxyUrl: 'https://relay.example.workers.dev',
      fetchRelayToken: 'relay-test-secret',
    }, token);

    expect(status).toBe(200);
    expect(body.fetchRelayTokenConfigured).toBe(true);
    expect(body).not.toHaveProperty('fetchRelayToken');
    expect(getSetting('fetch_relay_token')).not.toContain('relay-test-secret');

    const after = await request(app, 'GET', '/api/settings/proxy', undefined, token);
    expect(after.body.fetchRelayTokenConfigured).toBe(true);
    expect(after.body).not.toHaveProperty('fetchRelayToken');
  });

  it('rejects a SOCKS URL in fetch-relay mode without changing either setting', async () => {
    const before = await request(app, 'GET', '/api/settings/proxy', undefined, token);
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'fetch-relay',
      proxyUrl: 'socks5://127.0.0.1:1080',
    }, token);
    const after = await request(app, 'GET', '/api/settings/proxy', undefined, token);

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/must use https/);
    expect(after.body.proxyMode).toBe(before.body.proxyMode);
    expect(after.body.proxyUrl).toBe(before.body.proxyUrl);
  });

  // Unlike a forward proxy, which only tunnels the TLS session, a relay is
  // handed the provider API key and the relay token in cleartext. A plaintext
  // hop to a remote relay puts both on the wire, so only loopback may use it.
  it('rejects a plaintext http relay on a remote host', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'fetch-relay',
      proxyUrl: 'http://relay.example.workers.dev',
    }, token);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/must use https/);
  });

  for (const proxyUrl of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    it(`accepts the loopback relay ${proxyUrl}`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
        proxyMode: 'fetch-relay',
        proxyUrl,
      }, token);
      expect(status).toBe(200);
      expect(body.proxyMode).toBe('fetch-relay');
      expect(body.proxyUrl).toBe(proxyUrl);
    });
  }

  it('rejects a malformed relay URL', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'fetch-relay',
      proxyUrl: 'relay.example.workers.dev',
    }, token);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/Invalid Fetch Relay URL/);
  });

  it('rejects an unknown proxy mode', async () => {
    const { status, body } = await request(app, 'PUT', '/api/settings/proxy', {
      proxyMode: 'transparent',
    }, token);
    expect(status).toBe(400);
    expect(body.error.message).toMatch(/forward or fetch-relay/);
  });

  // A body that decides neither the URL nor the mode must not be validated
  // against whatever getProxyUrl() currently reports — that may be an ambient
  // ALL_PROXY the dashboard never set and cannot correct, which would leave
  // the enabled switch and the bypass list permanently 400ing.
  it('does not validate the ambient proxy URL on an unrelated partial update', async () => {
    process.env.ALL_PROXY = 'not a url';
    applyProxyUrl('');
    try {
      const { status, body } = await request(app, 'PUT', '/api/settings/proxy', { enabled: false }, token);
      expect(status).toBe(200);
      expect(body.enabled).toBe(false);
    } finally {
      delete process.env.ALL_PROXY;
      applyProxyUrl('');
      await request(app, 'PUT', '/api/settings/proxy', { enabled: true }, token);
    }
  });
});
