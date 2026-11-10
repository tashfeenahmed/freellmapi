import { afterEach, describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { isIpAddress, isLocalRequest, isLocalTrustDisabled, isLoopbackAddress, localTrustStartupWarning } from '../../lib/request-locality.js';

// isLocalRequest decides who gets first-run setup without a code, keyless
// Ollama open-loopback inference, and the desktop session / key-export
// shortcuts. These cases run a real Express app so req.ip comes from Express's
// own `trust proxy` chain, the same way createApp() wires TRUST_PROXY.

type Trust = boolean | number | string[];

function localityApp(remoteAddr: string, trust: Trust) {
  const app = express();
  app.set('trust proxy', trust);
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  app.get('/', (req, res) => { res.json({ local: isLocalRequest(req) }); });
  return app;
}

async function locality(remoteAddr: string, trust: Trust, headers: Record<string, string> = {}): Promise<boolean> {
  const server = localityApp(remoteAddr, trust).listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(JSON.parse(data).local));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe('isLoopbackAddress', () => {
  it('accepts 127.0.0.0/8, ::1 and IPv4-mapped forms', () => {
    for (const a of ['127.0.0.1', '127.0.0.53', '127.255.255.255', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const a of ['', undefined, null, '10.0.0.1', '192.168.1.2', '203.0.113.7', '127.0.0.256', '1127.0.0.1', '127.0.0.1.evil', '::2', 'localhost']) {
      expect(isLoopbackAddress(a as string), String(a)).toBe(false);
    }
  });
});

describe('isLocalRequest', () => {
  it('a direct loopback client is local under every TRUST_PROXY setting', async () => {
    for (const trust of [false, true, 1, 2, ['loopback']] as Trust[]) {
      expect(await locality('127.0.0.1', trust), JSON.stringify(trust)).toBe(true);
      expect(await locality('::1', trust), JSON.stringify(trust)).toBe(true);
    }
  });

  it('a remote socket is never local, whatever the headers claim', async () => {
    for (const trust of [false, true, 1, ['loopback']] as Trust[]) {
      expect(await locality('203.0.113.7', trust, { 'X-Forwarded-For': '127.0.0.1' })).toBe(false);
      expect(await locality('192.168.1.2', trust)).toBe(false);
    }
  });

  it('TRUST_PROXY unset: a proxied request is never local', async () => {
    expect(await locality('127.0.0.1', false, { 'X-Forwarded-For': '127.0.0.1' })).toBe(false);
    expect(await locality('127.0.0.1', false, { 'X-Forwarded-For': '203.0.113.7' })).toBe(false);
    expect(await locality('127.0.0.1', false, { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' })).toBe(false);
  });

  it('TRUST_PROXY=true: the left-most hop is client-written, so never local', async () => {
    expect(await locality('127.0.0.1', true, { 'X-Forwarded-For': '127.0.0.1' })).toBe(false);
    expect(await locality('127.0.0.1', true, { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' })).toBe(false);
  });

  it('TRUST_PROXY=1: uses the hop the trusted proxy appended, not the spoofable first entry', async () => {
    // Local browser through the proxy.
    expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': '127.0.0.1' })).toBe(true);
    // Remote client.
    expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': '203.0.113.7' })).toBe(false);
    // Remote client that wrote 127.0.0.1 itself; nginx appended the real address.
    expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' })).toBe(false);
  });

  it('a trusted-proxy address list stops at the first untrusted hop', async () => {
    const trust = ['loopback'];
    expect(await locality('127.0.0.1', trust, { 'X-Forwarded-For': '127.0.0.1' })).toBe(true);
    expect(await locality('127.0.0.1', trust, { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' })).toBe(false);
    expect(await locality('127.0.0.1', trust, { 'X-Forwarded-For': '127.0.0.1, 10.0.0.5, 127.0.0.1' })).toBe(false);
  });

  it('identity headers outside X-Forwarded-For cannot be verified, so never local', async () => {
    for (const [name, value] of [
      ['X-Real-IP', '127.0.0.1'],
      ['Forwarded', 'for=127.0.0.1'],
      ['True-Client-IP', '127.0.0.1'],
      ['CF-Connecting-IP', '127.0.0.1'],
      ['Fastly-Client-IP', '127.0.0.1'],
      ['X-Client-IP', '127.0.0.1'],
      ['X-Cluster-Client-IP', '127.0.0.1'],
    ]) {
      for (const trust of [false, 1] as Trust[]) {
        expect(await locality('127.0.0.1', trust, { [name]: value }), `${name} trust=${trust}`).toBe(false);
      }
    }
  });

  it('fails closed for a request object with no app (no trust configuration)', () => {
    const bare = (headers: Record<string, string>) => ({ socket: { remoteAddress: '127.0.0.1' }, httpVersion: '1.1', headers: { host: 'localhost', ...headers } }) as any;
    expect(isLocalRequest(bare({}))).toBe(true);
    expect(isLocalRequest(bare({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });
});

// A raw request line, so the HTTP version and the exact header set are under
// the test's control (nginx's default upstream request is HTTP/1.0).
async function rawLocality(requestHead: string, trust: Trust = false): Promise<boolean | undefined> {
  const server = localityApp('127.0.0.1', trust).listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(requestHead.replace(/\n/g, '\r\n') + '\r\n\r\n'));
      let data = '';
      sock.on('data', c => { data += c; });
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    if (!raw.startsWith('HTTP/1.1 200') && !raw.startsWith('HTTP/1.0 200')) return undefined;
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    return JSON.parse(body).local;
  } finally {
    server.close();
  }
}

describe('isIpAddress', () => {
  it('accepts well-formed IPv4 and IPv6', () => {
    for (const a of ['127.0.0.1', '0.0.0.0', '203.0.113.7', '::1', '::', '2001:db8::1', '::ffff:127.0.0.1', '1:2:3:4:5:6:7:8']) {
      expect(isIpAddress(a), a).toBe(true);
    }
  });
  it('rejects anything ambiguous', () => {
    for (const a of ['', 'unknown', '127.0.0.1:8080', '[::1]', '127.0.0.01', '1.2.3', '1:2:3:4:5:6:7:8:9', 'fe80::1%eth0', ' 127.0.0.1', '127.0.0.1 ']) {
      expect(isIpAddress(a), a).toBe(false);
    }
  });
});

describe('DISABLE_LOCAL_TRUST', () => {
  const saved = process.env.DISABLE_LOCAL_TRUST;
  afterEach(() => {
    if (saved === undefined) delete process.env.DISABLE_LOCAL_TRUST;
    else process.env.DISABLE_LOCAL_TRUST = saved;
  });

  it('parses on/off values and fails closed on anything else', () => {
    for (const v of [undefined, '', 'false', '0', 'no', 'off', 'FALSE']) {
      expect(isLocalTrustDisabled(v === undefined ? {} : { DISABLE_LOCAL_TRUST: v }), String(v)).toBe(false);
    }
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'ture', 'enabled', 'disable']) {
      expect(isLocalTrustDisabled({ DISABLE_LOCAL_TRUST: v }), v).toBe(true);
    }
  });

  it('when true, a direct loopback client is no longer local under any TRUST_PROXY', async () => {
    process.env.DISABLE_LOCAL_TRUST = 'true';
    for (const trust of [false, true, 1, ['loopback']] as Trust[]) {
      expect(await locality('127.0.0.1', trust), JSON.stringify(trust)).toBe(false);
      expect(await locality('::1', trust), JSON.stringify(trust)).toBe(false);
      expect(await locality('127.0.0.1', trust, { 'X-Forwarded-For': '127.0.0.1' })).toBe(false);
    }
  });

  it('when false, direct localhost keeps working', async () => {
    process.env.DISABLE_LOCAL_TRUST = 'false';
    expect(await locality('127.0.0.1', false)).toBe(true);
  });
});

describe('misconfigured-proxy signals', () => {
  // nginx's default upstream request: HTTP/1.0, Host = the upstream address,
  // and no forwarding headers when the config is a bare `proxy_pass`.
  it('refuses HTTP/1.0, the protocol nginx uses upstream by default', async () => {
    expect(await rawLocality('GET / HTTP/1.0\nHost: 127.0.0.1:3001\nConnection: close')).toBe(false);
    expect(await rawLocality('GET / HTTP/1.1\nHost: 127.0.0.1:3001\nConnection: close')).toBe(true);
  });

  it('refuses a Host header that is not a loopback name (forwarded public Host, DNS rebinding)', async () => {
    for (const host of ['dashboard.example.com', 'evil.example:3001', '192.168.1.5:3001', '10.0.0.1', 'localhost.evil.example', '127.0.0.1.nip.io']) {
      expect(await rawLocality(`GET / HTTP/1.1\nHost: ${host}\nConnection: close`), host).toBe(false);
    }
  });

  it('accepts the loopback names a local user can type', async () => {
    for (const host of ['localhost', 'localhost:3001', 'LOCALHOST:3001', '127.0.0.1:3001', '127.0.0.53', '[::1]:3001', '0.0.0.0:3001', '[::]:3001']) {
      expect(await rawLocality(`GET / HTTP/1.1\nHost: ${host}\nConnection: close`), host).toBe(true);
    }
  });

  it('refuses a request with no Host header', async () => {
    // Over real HTTP/1.1, Node answers 400 before any route runs, so the
    // helper never sees one; the helper refuses it anyway.
    expect(await rawLocality('GET / HTTP/1.1\nConnection: close')).toBeUndefined();
    const noHost = { socket: { remoteAddress: '127.0.0.1' }, httpVersion: '1.1', headers: {} } as any;
    expect(isLocalRequest(noHost)).toBe(false);
  });

  it('treats any partial proxy header as proxied, and refuses it without a verifiable chain', async () => {
    for (const [name, value] of [
      ['X-Forwarded-Proto', 'https'],
      ['X-Forwarded-Host', 'localhost'],
      ['X-Forwarded-Port', '443'],
      ['Via', '1.1 nginx'],
    ]) {
      for (const trust of [false, 1] as Trust[]) {
        expect(await locality('127.0.0.1', trust, { [name]: value }), `${name} trust=${trust}`).toBe(false);
      }
    }
  });
});

describe('conflicting and ambiguous forwarding headers fail closed', () => {
  // nginx with only `proxy_set_header X-Real-IP $remote_addr;` passes the
  // client's own X-Forwarded-For through untouched. The trusted proxy has
  // stated the client in X-Real-IP; a client-written X-Forwarded-For that
  // disagrees must not win.
  it('X-Real-IP from the proxy beats a spoofed X-Forwarded-For', async () => {
    for (const trust of [1, ['loopback']] as Trust[]) {
      expect(await locality('127.0.0.1', trust, { 'X-Real-IP': '203.0.113.7', 'X-Forwarded-For': '127.0.0.1' })).toBe(false);
    }
  });

  it('X-Real-IP never grants locality on its own', async () => {
    for (const trust of [false, true, 1] as Trust[]) {
      expect(await locality('127.0.0.1', trust, { 'X-Real-IP': '127.0.0.1' })).toBe(false);
    }
  });

  it('agreeing X-Real-IP and X-Forwarded-For through a trusted proxy is local', async () => {
    expect(await locality('127.0.0.1', 1, { 'X-Real-IP': '127.0.0.1', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'http' })).toBe(true);
  });

  it('refuses X-Real-IP that is malformed, multi-valued, or a different loopback address', async () => {
    for (const realIp of ['localhost', '127.0.0.1, 127.0.0.1', '127.0.0.1:80', '127.0.0.2']) {
      expect(await locality('127.0.0.1', 1, { 'X-Real-IP': realIp, 'X-Forwarded-For': '127.0.0.1' }), realIp).toBe(false);
    }
  });

  it('refuses an X-Forwarded-For chain with any malformed entry', async () => {
    for (const xff of ['unknown, 127.0.0.1', '127.0.0.1:5000', '127.0.0.1,', ', 127.0.0.1', '[::1]', 'localhost']) {
      expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': xff }), xff).toBe(false);
    }
  });

  it('refuses a request that also carries an unverifiable identity header', async () => {
    expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1' })).toBe(false);
    expect(await locality('127.0.0.1', 1, { 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' })).toBe(false);
  });
});

describe('localTrustStartupWarning', () => {
  it('warns when TRUST_PROXY is set and DISABLE_LOCAL_TRUST is not', () => {
    expect(localTrustStartupWarning(1, {})).toMatch(/DISABLE_LOCAL_TRUST=true/);
    expect(localTrustStartupWarning(['loopback'], {})).toMatch(/DISABLE_LOCAL_TRUST/);
  });
  it('stays quiet without TRUST_PROXY, or once DISABLE_LOCAL_TRUST is chosen either way', () => {
    expect(localTrustStartupWarning(false, {})).toBeNull();
    expect(localTrustStartupWarning(1, { DISABLE_LOCAL_TRUST: 'true' })).toBeNull();
    expect(localTrustStartupWarning(1, { DISABLE_LOCAL_TRUST: 'false' })).toBeNull();
  });
});
