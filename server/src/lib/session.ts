import crypto from 'crypto';
import { getSessionSecret } from '../env.js';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function toBase64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(s: string): Buffer {
  const pad = (4 - (s.length % 4)) % 4;
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

function computeHmac(payload: string): Buffer {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest();
}

export function signSession(email: string): string {
  const exp = Date.now() + SESSION_DURATION_MS;
  const payload = toBase64url(Buffer.from(JSON.stringify({ email, exp })));
  const hmac = toBase64url(computeHmac(payload));
  return `${payload}.${hmac}`;
}

export type SessionData = { email: string; exp: number };

export function verifySession(token: string): SessionData | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;

  const payload = token.slice(0, dot);
  const providedHmac = fromBase64url(token.slice(dot + 1));
  const expectedHmac = computeHmac(payload);

  if (
    providedHmac.length !== expectedHmac.length ||
    !crypto.timingSafeEqual(providedHmac, expectedHmac)
  ) {
    return null;
  }

  let data: SessionData;
  try {
    data = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return null;
  }

  if (typeof data.email !== 'string' || typeof data.exp !== 'number') return null;
  if (Date.now() > data.exp) return null;

  return data;
}
