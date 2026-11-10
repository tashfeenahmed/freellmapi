import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import { isLocalRequest, isLoopbackAddress } from '../../lib/request-locality.js';

// isLocalRequest decides who gets first-run setup without a code, keyless
// Ollama open-loopback inference, and the desktop session / key-export
// shortcuts. These cases run a real Express app so req.ip comes from Express's
// own `trust proxy` chain, the same way createApp() wires TRUST_PROXY.

type Trust = boolean | number | string[];

async function locality(remoteAddr: string, trust: Trust, headers: Record<string, string> = {}): Promise<boolean> {
  const app = express();
  app.set('trust proxy', trust);
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  app.get('/', (req, res) => { res.json({ local: isLocalRequest(req) }); });
  const server = app.listen(0, '127.0.0.1');
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
    const bare = (headers: Record<string, string>) => ({ socket: { remoteAddress: '127.0.0.1' }, headers }) as any;
    expect(isLocalRequest(bare({}))).toBe(true);
    expect(isLocalRequest(bare({ 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });
});
