import { next } from '@vercel/functions';

const SESSION_COOKIE = 'freellmapi_session';
const DEFAULT_USERNAME = 'nguyenhoang287';
const DEFAULT_PASSWORD = 'Matkhau1@';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function authUsername(): string {
  return process.env.FREELLM_AUTH_USERNAME ?? process.env.AUTH_USERNAME ?? DEFAULT_USERNAME;
}

function authPassword(): string {
  return process.env.FREELLM_AUTH_PASSWORD ?? process.env.AUTH_PASSWORD ?? DEFAULT_PASSWORD;
}

function authSecret(): string {
  return process.env.FREELLM_AUTH_SECRET
    ?? process.env.AUTH_SECRET
    ?? process.env.ENCRYPTION_KEY
    ?? `${authUsername()}:${authPassword()}`;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  if (!header) return {};

  return header.split(';').reduce<Record<string, string>>((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function hasValidSession(request: Request): Promise<boolean> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return false;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature || !safeEqual(signature, await sign(encoded))) return false;

  try {
    const payload = JSON.parse(decoder.decode(base64UrlToBytes(encoded))) as {
      sub?: unknown;
      exp?: unknown;
      nonce?: unknown;
    };
    return typeof payload.sub === 'string'
      && typeof payload.exp === 'number'
      && typeof payload.nonce === 'string'
      && payload.exp > Math.floor(Date.now() / 1000)
      && safeEqual(payload.sub, authUsername());
  } catch {
    return false;
  }
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return true;
  return /\.(?:css|js|map|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/i.test(pathname);
}

export default async function middleware(request: Request) {
  const url = new URL(request.url);
  if (isPublicPath(url.pathname) || await hasValidSession(request)) {
    return next();
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: { message: 'Authentication required' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', `${url.pathname}${url.search}`);
  return Response.redirect(loginUrl, 302);
}
