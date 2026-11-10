import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { loadConfig } from '../../lib/config.js';
import { getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { generateSetupCode, getSetupCode } from '../../lib/setup-code.js';

// Locality against a REAL nginx in front of the real app (#security review).
//
// Every request goes client -> nginx -> app over real sockets, so the headers,
// HTTP version and Host the app sees are exactly what nginx produces for each
// config, not a hand-written guess. A "remote" client binds this machine's
// non-loopback address, which nginx reports as $remote_addr just as it would
// for a client across the network.
//
// Two probes, which must agree because every locality surface shares one
// policy (lib/request-locality.ts):
//   - POST /api/auth/setup with an invalid body: 403 setup_code_required means
//     "remote", 400 (validation, reached only past the locality gate) means
//     "local". Nothing is ever created.
//   - GET /api/tags with Ollama open-loopback on: 200 local, 403 remote.
//
// Skips when nginx or a non-loopback address is missing. CI sets
// REQUIRE_NGINX_TESTS=1 so a missing nginx fails instead of skipping silently.

function findNginx(): string | null {
  const candidates = [process.env.NGINX_BIN, '/usr/sbin/nginx', '/usr/local/sbin/nginx', '/usr/bin/nginx', '/opt/homebrew/bin/nginx', '/usr/local/bin/nginx'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    return execFileSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function findRemoteAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const NGINX = findNginx();
const REMOTE_IP = findRemoteAddress();
const AVAILABLE = !!NGINX && !!REMOTE_IP;
const REQUIRED = process.env.REQUIRE_NGINX_TESTS === '1';

type Trust = false | true | number | string[];
const TRUST_MODES: Array<[string, Trust]> = [
  ['unset', false],
  ['1', 1],
  ['true', true],
  ['loopback', ['loopback']],
];

// nginx configs under test. `trustedChain`: nginx itself writes an
// X-Forwarded-For the app can verify through TRUST_PROXY.
interface Style { name: string; directives: string; trustedChain: boolean }
const STYLES: Style[] = [
  {
    name: 'xff-remote-addr',
    trustedChain: true,
    directives: `proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;`,
  },
  {
    name: 'xff-append',
    trustedChain: true,
    directives: `proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;`,
  },
  {
    // The documented secure example (docs/en/proxy/02-nginx.md).
    name: 'recommended',
    trustedChain: true,
    directives: `proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;`,
  },
  {
    name: 'real-ip-only',
    trustedChain: false,
    directives: `proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;`,
  },
  {
    // nginx defaults: HTTP/1.0 upstream, Host = the upstream address.
    name: 'bare',
    trustedChain: false,
    directives: '',
  },
  {
    // HTTP/1.1 and no forwarding headers: indistinguishable from a local
    // client. Only DISABLE_LOCAL_TRUST closes it.
    name: 'bare-http11',
    trustedChain: false,
    directives: 'proxy_http_version 1.1;',
  },
];

interface ClientKind { name: string; remote: boolean; headers: Record<string, string> }
// Remote clients that attack send Host: localhost, since nginx's $host copies
// whatever the client sent.
const CLIENTS: ClientKind[] = [
  { name: 'local browser', remote: false, headers: {} },
  { name: 'remote', remote: true, headers: {} },
  { name: 'remote, Host: localhost', remote: true, headers: { Host: 'localhost' } },
  { name: 'remote, spoofed XFF', remote: true, headers: { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1' } },
  { name: 'remote, spoofed X-Real-IP', remote: true, headers: { Host: 'localhost', 'X-Real-IP': '127.0.0.1' } },
  { name: 'remote, spoofed XFF + X-Real-IP', remote: true, headers: { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' } },
  { name: 'remote, spoofed XFF chain', remote: true, headers: { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1, 127.0.0.1' } },
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '0.0.0.0', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function send(
  target: { host: string; port: number; localAddress?: string },
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.host,
      port: target.port,
      localAddress: target.localAddress,
      method,
      path: pathname,
      agent: false,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

let nginx: ChildProcess | null = null;
let workDir = '';
const appServers: Server[] = [];
// nginx port per `${style}|${trustMode}`
const nginxPorts = new Map<string, number>();
const appPorts = new Map<string, number>();

async function waitForPort(host: string, port: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.connect(port, host, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`nginx did not start listening on ${host}:${port}`);
}

/** Through nginx for (style, trust): does each surface treat `client` as local? */
async function probe(style: string, trustMode: string, client: ClientKind): Promise<boolean> {
  const port = nginxPorts.get(`${style}|${trustMode}`)!;
  const target = client.remote
    ? { host: REMOTE_IP!, port, localAddress: REMOTE_IP! }
    : { host: '127.0.0.1', port };
  const setup = await send(target, 'POST', '/api/auth/setup', client.headers, '{"email":"x"}');
  const tags = await send(target, 'GET', '/api/tags', client.headers);
  expect([400, 403], `setup status ${setup.status}: ${setup.body}`).toContain(setup.status);
  expect([200, 403], `tags status ${tags.status}: ${tags.body}`).toContain(tags.status);
  const setupLocal = setup.status === 400;
  const ollamaLocal = tags.status === 200;
  // One policy: both surfaces must reach the same verdict.
  expect(ollamaLocal, `setup and Ollama disagree for ${style}/${trustMode}/${client.name}`).toBe(setupLocal);
  return setupLocal;
}

async function withLocalTrustDisabled<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DISABLE_LOCAL_TRUST = 'true';
  try {
    return await fn();
  } finally {
    delete process.env.DISABLE_LOCAL_TRUST;
  }
}

if (!AVAILABLE && REQUIRED) {
  describe('nginx reverse-proxy locality (required)', () => {
    it('has nginx and a non-loopback address available', () => {
      expect.fail(`REQUIRE_NGINX_TESTS=1 but nginx=${NGINX ?? 'missing'}, non-loopback address=${REMOTE_IP ?? 'missing'}`);
    });
  });
}

describe.skipIf(!AVAILABLE)('nginx reverse-proxy locality', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.DISABLE_LOCAL_TRUST;
    initDb(':memory:');
    generateSetupCode();
    setSetting('ollama_emulation', 'open-loopback');

    for (const [mode, trust] of TRUST_MODES) {
      const app = createApp({ ...loadConfig(), trustProxy: trust, proxyRateLimitRpm: 0, serveStaticAssets: false });
      const server = app.listen(0, '127.0.0.1');
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
      appServers.push(server);
      appPorts.set(mode, (server.address() as net.AddressInfo).port);
    }

    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-nginx-'));
    const blocks: string[] = [];
    for (const style of STYLES) {
      for (const [mode] of TRUST_MODES) {
        const port = await freePort();
        nginxPorts.set(`${style.name}|${mode}`, port);
        blocks.push(`
  server {
    listen 127.0.0.1:${port};
    listen ${REMOTE_IP}:${port};
    location / {
      proxy_pass http://127.0.0.1:${appPorts.get(mode)};
      ${style.directives}
    }
  }`);
      }
    }
    const t = (n: string) => path.join(workDir, n);
    fs.writeFileSync(t('nginx.conf'), `
pid ${t('nginx.pid')};
error_log ${t('error.log')} warn;
worker_processes 1;
events { worker_connections 256; }
http {
  access_log off;
  client_body_temp_path ${t('client_body')};
  proxy_temp_path ${t('proxy')};
  fastcgi_temp_path ${t('fastcgi')};
  uwsgi_temp_path ${t('uwsgi')};
  scgi_temp_path ${t('scgi')};
${blocks.join('\n')}
}
`);
    nginx = spawn(NGINX!, ['-p', workDir, '-c', t('nginx.conf'), '-e', t('error.log'), '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    nginx.stderr?.on('data', c => { stderr += c; });
    const first = nginxPorts.values().next().value as number;
    try {
      await waitForPort('127.0.0.1', first);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n${stderr}\n${fs.existsSync(t('error.log')) ? fs.readFileSync(t('error.log'), 'utf8') : ''}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (nginx && nginx.exitCode === null) {
      const exited = new Promise(resolve => nginx!.once('exit', resolve));
      nginx.kill('SIGQUIT');
      await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
      if (nginx.exitCode === null) nginx.kill('SIGKILL');
    }
    await Promise.all(appServers.map(s => new Promise(resolve => s.close(resolve))));
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('direct localhost (no proxy) stays local under every TRUST_PROXY mode', async () => {
    for (const [mode] of TRUST_MODES) {
      const target = { host: '127.0.0.1', port: appPorts.get(mode)! };
      expect((await send(target, 'POST', '/api/auth/setup', {}, '{"email":"x"}')).status, mode).toBe(400);
      expect((await send(target, 'GET', '/api/tags')).status, mode).toBe(200);
    }
  });

  it('a remote client is never local through any correctly configured proxy, spoofed headers or not', async () => {
    for (const style of STYLES.filter(s => s.trustedChain || s.name === 'real-ip-only' || s.name === 'bare')) {
      for (const [mode] of TRUST_MODES) {
        for (const client of CLIENTS.filter(c => c.remote)) {
          expect(await probe(style.name, mode, client), `${style.name} / TRUST_PROXY=${mode} / ${client.name}`).toBe(false);
        }
      }
    }
  }, 60_000);

  it('a local browser through the proxy is local only with a verifiable chain and TRUST_PROXY=1 or an address list', async () => {
    const local = CLIENTS[0]!;
    for (const style of STYLES.filter(s => s.name !== 'bare-http11')) {
      for (const [mode, trust] of TRUST_MODES) {
        const expected = style.trustedChain && (typeof trust === 'number' || Array.isArray(trust));
        expect(await probe(style.name, mode, local), `${style.name} / TRUST_PROXY=${mode}`).toBe(expected);
      }
    }
  }, 60_000);

  // nginx forwarding only X-Real-IP passes the client's X-Forwarded-For
  // through untouched. Before this fix, TRUST_PROXY=1 resolved that spoof as
  // the client and granted locality.
  it('X-Real-IP-only nginx: a spoofed X-Forwarded-For never overrides the proxy-stated client', async () => {
    for (const [mode] of TRUST_MODES) {
      for (const client of CLIENTS.filter(c => c.remote)) {
        expect(await probe('real-ip-only', mode, client), `TRUST_PROXY=${mode} / ${client.name}`).toBe(false);
      }
    }
  }, 60_000);

  // nginx's default upstream request is HTTP/1.0, which is never local.
  it('bare proxy_pass (nginx defaults) is never local, even before DISABLE_LOCAL_TRUST', async () => {
    for (const [mode] of TRUST_MODES) {
      for (const client of CLIENTS) {
        expect(await probe('bare', mode, client), `TRUST_PROXY=${mode} / ${client.name}`).toBe(false);
      }
    }
  }, 60_000);

  // Known limit, pinned so a change is noticed: with proxy_http_version 1.1
  // and no forwarding headers, a remote request that sends Host: localhost is
  // byte-for-byte a local one. DISABLE_LOCAL_TRUST is the fix.
  it('bare proxy_pass with HTTP/1.1 is undetectable without DISABLE_LOCAL_TRUST', async () => {
    const attacker = CLIENTS.find(c => c.name === 'remote, Host: localhost')!;
    expect(await probe('bare-http11', 'unset', attacker)).toBe(true);
  });

  it('DISABLE_LOCAL_TRUST=true: nothing is local through any proxy, and not directly either', async () => {
    await withLocalTrustDisabled(async () => {
      for (const style of STYLES) {
        for (const [mode] of TRUST_MODES) {
          for (const client of CLIENTS) {
            expect(await probe(style.name, mode, client), `${style.name} / TRUST_PROXY=${mode} / ${client.name}`).toBe(false);
          }
        }
      }
      for (const [mode] of TRUST_MODES) {
        const target = { host: '127.0.0.1', port: appPorts.get(mode)! };
        expect((await send(target, 'POST', '/api/auth/setup', {}, '{"email":"x"}')).status).toBe(403);
        expect((await send(target, 'GET', '/api/tags')).status).toBe(403);
      }
    });
  }, 120_000);

  it('remote access through a trusted proxy still works with real credentials', async () => {
    await withLocalTrustDisabled(async () => {
      const target = { host: REMOTE_IP!, port: nginxPorts.get('recommended|1')!, localAddress: REMOTE_IP! };
      const models = await send(target, 'GET', '/v1/models', { Host: 'dashboard.example.com', Authorization: `Bearer ${getUnifiedApiKey()}` });
      expect(models.status).toBe(200);
      expect(JSON.parse(models.body).object).toBe('list');
      expect((await send(target, 'GET', '/v1/models', { Host: 'dashboard.example.com' })).status).toBe(401);
      // The setup code still opens first-run setup (400 = past the code gate,
      // stopped only by the deliberately invalid body).
      const setup = await send(target, 'POST', '/api/auth/setup', { Host: 'dashboard.example.com' }, JSON.stringify({ email: 'x', setupCode: getSetupCode() }));
      expect(setup.status).toBe(400);
    });
  });
});
