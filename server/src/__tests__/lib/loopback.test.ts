import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { isLocalRequest } from '../../lib/loopback.js';

// Locality grants the setup-code exemption, desktop sign-in, the desktop
// re-auth skip and Ollama open-loopback. Forwarded headers may only withdraw it.
function req(
  remoteAddress: string,
  headers: Record<string, string | string[]> = {},
  trustProxy: unknown = false,
): Request {
  return {
    socket: { remoteAddress },
    headers,
    app: { get: (name: string) => (name === 'trust proxy' ? trustProxy : undefined) },
  } as unknown as Request;
}

describe('isLocalRequest', () => {
  it('accepts a direct loopback caller', () => {
    expect(isLocalRequest(req('127.0.0.1'))).toBe(true);
    expect(isLocalRequest(req('::1'))).toBe(true);
    expect(isLocalRequest(req('::FFFF:127.0.0.1'))).toBe(true);
  });

  it('rejects a non-loopback socket whatever the headers claim', () => {
    expect(isLocalRequest(req('192.168.1.20', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
  });

  it('needs every X-Forwarded-For hop to be loopback, across header lines', () => {
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, ::1' }))).toBe(true);
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': ['127.0.0.1', '203.0.113.9'] }))).toBe(false);
  });

  it('fails closed on forms it does not parse', () => {
    for (const hop of ['[::1]', '127.0.0.1:8080', '::1%lo0', 'unknown']) {
      expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': hop })), hop).toBe(false);
    }
  });

  it('checks the single-IP client headers proxies and CDNs set', () => {
    for (const name of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip']) {
      expect(isLocalRequest(req('127.0.0.1', { [name]: '203.0.113.9' })), name).toBe(false);
      expect(isLocalRequest(req('127.0.0.1', { [name]: '127.0.0.1' })), name).toBe(true);
    }
  });

  it('withdraws locality when a Forwarded header is present', () => {
    expect(isLocalRequest(req('127.0.0.1', { forwarded: 'for=127.0.0.1' }))).toBe(false);
  });

  // A bare `proxy_pass` sets no forwarded header at all, so every internet
  // caller looks like a loopback socket. TRUST_PROXY says a proxy is in front.
  it('fails closed when the operator declared a reverse proxy (trust proxy)', () => {
    expect(isLocalRequest(req('127.0.0.1', {}, 1))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', {}, true))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', {}, ['loopback']))).toBe(false);
  });
});
