import { afterEach, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { clientContextMiddleware, getClientContext } from '../../lib/client-context.js';

// Minimal fake req: the middleware only touches headers and socket.
function fakeReq(headers: Record<string, string | string[]>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

// Run the middleware and capture the context visible to downstream code
// (i.e. what logRequest would read inside the request's async scope).
function contextFor(req: Request): ReturnType<typeof getClientContext> {
  let seen = getClientContext();
  clientContextMiddleware(req, {} as Response, (() => { seen = getClientContext(); }) as NextFunction);
  return seen;
}

describe('clientContextMiddleware', () => {
  afterEach(() => {
    delete process.env.REQUEST_ANALYTICS_LOG_CLIENT;
  });

  it('captures the socket peer address and user agent', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: '192.168.0.42', userAgent: 'curl/8.6.0' });
  });

  it('prefers the first X-Forwarded-For hop over the socket address', () => {
    const ctx = contextFor(fakeReq(
      { 'x-forwarded-for': '10.1.2.3, 172.16.0.1', 'user-agent': 'ua' },
      '127.0.0.1',
    ));
    expect(ctx.ip).toBe('10.1.2.3');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const ctx = contextFor(fakeReq({}, '::ffff:192.168.0.5'));
    expect(ctx.ip).toBe('192.168.0.5');
  });

  it('truncates oversized user agents to 256 chars', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'x'.repeat(1000) }, '1.2.3.4'));
    expect(ctx.userAgent).toHaveLength(256);
  });

  it('stores nulls when REQUEST_ANALYTICS_LOG_CLIENT=false', () => {
    process.env.REQUEST_ANALYTICS_LOG_CLIENT = 'false';
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: null, userAgent: null });
  });

  it('returns nulls outside any request scope', () => {
    expect(getClientContext()).toEqual({ ip: null, userAgent: null });
  });
});
