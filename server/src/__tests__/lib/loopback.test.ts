import { describe, it, expect } from 'vitest';
import { isLoopbackAddress, forwardedPeerAddress, isLoopbackRequest } from '../../lib/loopback.js';

// Locality (#1884): the socket peer decides, and the RIGHT-most forwarded hop
// (the one the nearest proxy appended) can withdraw it, never grant it.
const req = (remoteAddress: string, forwarded?: string) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '::ffff:127.0.0.1', ' 127.0.0.1 '])('accepts %s', a => {
    expect(isLoopbackAddress(a)).toBe(true);
  });
  it.each(['127.999.0.1', '127.0.0.256', '127.0.0', '128.0.0.1', '10.0.0.1', '::2', '', '127.0.0.1:8080', 'localhost'])('rejects %s', a => {
    expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe('forwardedPeerAddress', () => {
  it('returns the right-most non-empty hop', () => {
    expect(forwardedPeerAddress('127.0.0.1, 203.0.113.9')).toBe('203.0.113.9');
    expect(forwardedPeerAddress(', 203.0.113.9')).toBe('203.0.113.9');
    expect(forwardedPeerAddress(['127.0.0.1', '198.51.100.7'])).toBe('198.51.100.7');
    expect(forwardedPeerAddress(undefined)).toBe('');
    expect(forwardedPeerAddress(' , ')).toBe('');
  });
});

describe('isLoopbackRequest', () => {
  it('is local for a loopback socket with no forwarded hop', () => {
    expect(isLoopbackRequest(req('127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('::ffff:127.0.0.1'))).toBe(true);
  });
  it('is local when the proxy itself saw a loopback client', () => {
    expect(isLoopbackRequest(req('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('127.0.0.1', '203.0.113.9, 127.0.0.1'))).toBe(true);
  });
  it('is not local when a caller prepends 127.0.0.1 through an appending proxy', () => {
    expect(isLoopbackRequest(req('127.0.0.1', '127.0.0.1, 203.0.113.9'))).toBe(false);
  });
  it('is not local for an empty first hop', () => {
    expect(isLoopbackRequest(req('127.0.0.1', ',203.0.113.9'))).toBe(false);
  });
  it('never grants locality to a remote socket', () => {
    expect(isLoopbackRequest(req('192.168.1.42', '127.0.0.1'))).toBe(false);
  });
});
