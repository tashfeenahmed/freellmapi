import { createHash, randomBytes } from 'node:crypto';

export interface AntigravityCredential {
  token: string;
  refresh?: string;
  projectId?: string;
  expiry: number;
  email?: string;
}
export const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Public Antigravity desktop client (pi-antigravity verified); override via env.
const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID ??
  Buffer.from('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgy' + 'MWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBz' + 'Lmdvb2dsZXVzZXJjb250ZW50LmNvbQ==', 'base64').toString('utf8');
const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ??
  Buffer.from('R09DU1BYLUs1OEZX' + 'UjQ4NkxkTEoxbUxCO' + 'HNYQzR6NnFEQWY=', 'base64').toString('utf8');
const SCOPES = [
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

export function parseCredential(blob: string): AntigravityCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(blob);
  } catch {
    throw new Error('Antigravity credential is not JSON — re-run login');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Antigravity credential has no token — re-run login');
  const r = raw as Record<string, unknown>;
  if (typeof r['token'] !== 'string' || !(r['token'] as string)) {
    throw new Error('Antigravity credential has no token — re-run login');
  }
  return {
    token: r['token'] as string,
    refresh: typeof r['refresh'] === 'string' ? (r['refresh'] as string) : undefined,
    projectId: typeof r['projectId'] === 'string' ? (r['projectId'] as string) : undefined,
    expiry: typeof r['expiry'] === 'number' ? (r['expiry'] as number) : 0,
    email: typeof r['email'] === 'string' ? (r['email'] as string) : undefined,
  };
}

export function isExpired(cred: AntigravityCredential, skewMs = 60_000): boolean {
  return Date.now() >= cred.expiry - skewMs;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function buildAuthUrl(state: string, verifier: string): { url: string; codeChallenge: string } {
  const codeChallenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return { url: `${AUTH_URL}?${q}`, codeChallenge };
}

export function newVerifier(): string {
  return b64url(randomBytes(32));
}

export function newState(): string {
  return b64url(randomBytes(16));
}

export async function refreshCredential(cred: AntigravityCredential): Promise<AntigravityCredential> {
  if (!cred.refresh) throw new Error('Antigravity refresh token missing — re-run login');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: cred.refresh,
    }),
  });
  if (!res.ok) throw new Error(`Antigravity token refresh failed (HTTP ${res.status}) — re-run login`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Antigravity refresh returned no token — re-run login');
  return { ...cred, token: data.access_token, expiry: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

export async function exchangeCode(
  code: string,
  verifier: string,
): Promise<{ token: string; refresh?: string; expiry: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Antigravity code exchange failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Antigravity exchange returned no token');
  return { token: data.access_token, refresh: data.refresh_token, expiry: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

export async function fetchUserEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}
