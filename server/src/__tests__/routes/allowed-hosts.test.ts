import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Host-header allowlist (#1637). node:http rather than fetch(): undici
// silently rewrites Host to the connect target, and Host is the header under
// test (same trick as csp-security.test.ts / auth-desktop-session.test.ts).

let previousAllowed: string | undefined;

function appWithAllowed(allowed: string | undefined): Express {
  if (allowed === undefined) delete process.env.ALLOWED_HOSTS;
  else process.env.ALLOWED_HOSTS = allowed;
  return createApp();
}

function call(
  app: Express,
  path: string,
  host: string | undefined,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const headers: Record<string, string> = {};
      if (host !== undefined) headers.host = host;
      const req = http.request(
        { host: '127.0.0.1', port, path, headers },
        res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', err => { server.close(); reject(err); });
      req.end();
    });
  });
}

describe('Host-header guard (#1637)', () => {
  beforeAll(() => {
    previousAllowed = process.env.ALLOWED_HOSTS;
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterAll(() => {
    if (previousAllowed === undefined) delete process.env.ALLOWED_HOSTS;
    else process.env.ALLOWED_HOSTS = previousAllowed;
  });

  describe('default (no ALLOWED_HOSTS): guard off', () => {
    // Opt-in on purpose: a loopback-only default would 403 LAN, Docker-network,
    // desktop-LAN and reverse-proxy installs the moment they upgraded.
    it('lets any Host through, including LAN IPs, container names and proxies', async () => {
      const app = appWithAllowed(undefined);
      for (const host of ['localhost:3001', '192.168.1.50:3001', 'freellmapi:3001', 'proxy.example.com', 'evil.example:3001']) {
        expect((await call(app, '/api/ping', host)).status, host).toBe(200);
      }
    });

    it('an empty ALLOWED_HOSTS is also off', async () => {
      expect((await call(appWithAllowed('  '), '/api/ping', '192.168.1.50:3001')).status).toBe(200);
    });
  });

  describe('loopback-only (ALLOWED_HOSTS=localhost)', () => {
    it('rejects a rebinding hostname with 403 before routing', async () => {
      const res = await call(appWithAllowed('localhost'), '/api/ping', 'evil.example:3001');
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.message).toContain('ALLOWED_HOSTS');
    });

    it('accepts the loopback names on any port', async () => {
      const app = appWithAllowed('localhost');
      for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001', 'app.localhost']) {
        const res = await call(app, '/api/ping', host);
        expect(res.status, host).toBe(200);
      }
    });

    it('accepts a bare 127.0.0.1 Host with no port', async () => {
      expect((await call(appWithAllowed('localhost'), '/api/ping', '127.0.0.1')).status).toBe(200);
    });

    it('rejects an unlisted LAN IP', async () => {
      expect((await call(appWithAllowed('localhost'), '/api/ping', '192.168.1.50:3001')).status).toBe(403);
    });
  });

  describe('ALLOWED_HOSTS entries', () => {
    it('accepts a listed hostname, case-insensitively, ignoring the port', async () => {
      const app = appWithAllowed('ai.home.arpa, DASH.Example.COM');
      expect((await call(app, '/api/ping', 'ai.home.arpa:3001')).status).toBe(200);
      expect((await call(app, '/api/ping', 'dash.example.com')).status).toBe(200);
    });

    it('still rejects unlisted hostnames', async () => {
      const app = appWithAllowed('ai.home.arpa');
      expect((await call(app, '/api/ping', 'evil.example:3001')).status).toBe(403);
      // A suffix-lookalike of an allowed name is not allowed.
      expect((await call(app, '/api/ping', 'ai.home.arpa.evil.example')).status).toBe(403);
    });

    it('still accepts loopback alongside the entries', async () => {
      const app = appWithAllowed('ai.home.arpa');
      expect((await call(app, '/api/ping', 'localhost:3001')).status).toBe(200);
    });

    it('a single * disables the guard', async () => {
      const app = appWithAllowed('*');
      expect((await call(app, '/api/ping', 'evil.example:3001')).status).toBe(200);
    });
  });

  describe('guard runs before auth', () => {
    it('403s an unauthenticated /api/keys call on a bad Host (not 401)', async () => {
      const res = await call(appWithAllowed('localhost'), '/api/keys', 'evil.example:3001');
      expect(res.status).toBe(403);
    });
  });
});
