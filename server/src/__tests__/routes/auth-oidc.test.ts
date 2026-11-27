import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createUser } from '../../services/auth.js';
import { applyDeclarativeConfig } from '../../services/declarative-config.js';
import { resetOidcState } from '../../services/oidc.js';

// Real local mock OIDC IdP (RS256 JWKS + discovery + token + userinfo) so the
// tests exercise openid-client v6 end to end with real JWT signature, PKCE,
// nonce, state, and max_age verification.

interface MockUserClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  groups?: string[];
  /** Put groups only in /userinfo instead of the ID token to test UserInfo fallback. */
  groupsOnlyInUserInfo?: boolean;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key-1', use: 'sig', alg: 'RS256' };

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  return `${data}.${sig}`;
}

let idpServer: http.Server;
let idpIssuer = '';
let nextClaims: MockUserClaims = { sub: 'sub-admin-1', email: 'admin@example.com', email_verified: true };
const issuedCodes = new Map<string, { nonce?: string; codeChallenge?: string; claims: MockUserClaims; maxAge?: string }>();
const accessTokens = new Map<string, MockUserClaims>();

let appServer: http.Server;
let appOrigin = '';

const OIDC_ENV_KEYS = [
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_SCOPES',
  'OIDC_PROVIDER_NAME',
  'OIDC_ALLOWED_EMAILS',
  'OIDC_ALLOWED_GROUPS',
  'OIDC_GROUPS_CLAIM',
  'OIDC_AUTO_PROVISION',
  'OIDC_ALLOW_ANY_USER',
  'OIDC_DISABLE_PASSWORD_LOGIN',
  'OIDC_AUTO_REDIRECT',
  'OIDC_REQUIRE_VERIFIED_EMAIL',
  'OIDC_POST_LOGOUT_REDIRECT_URI',
] as const;

function clearOidcEnv(): void {
  for (const key of OIDC_ENV_KEYS) delete process.env[key];
}

async function startMockIdp(): Promise<void> {
  idpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idpIssuer || 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: idpIssuer,
        authorization_endpoint: `${idpIssuer}/authorize`,
        token_endpoint: `${idpIssuer}/token`,
        userinfo_endpoint: `${idpIssuer}/userinfo`,
        jwks_uri: `${idpIssuer}/jwks`,
        end_session_endpoint: `${idpIssuer}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const nonce = url.searchParams.get('nonce') ?? undefined;
      const codeChallenge = url.searchParams.get('code_challenge') ?? undefined;
      const maxAge = url.searchParams.get('max_age') ?? undefined;
      const code = crypto.randomBytes(12).toString('base64url');
      issuedCodes.set(code, { nonce, codeChallenge, claims: { ...nextClaims }, maxAge });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const code = body.get('code') ?? '';
      const codeVerifier = body.get('code_verifier') ?? '';
      const entry = issuedCodes.get(code);
      issuedCodes.delete(code);
      if (!entry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      if (entry.codeChallenge) {
        const expected = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        if (expected !== entry.codeChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
          return;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const idPayload: Record<string, unknown> = {
        iss: idpIssuer,
        sub: entry.claims.sub,
        aud: process.env.OIDC_CLIENT_ID || 'freellmapi-test',
        iat: nowSec,
        exp: nowSec + 300,
        auth_time: nowSec,
      };
      if (entry.nonce) idPayload.nonce = entry.nonce;
      if (entry.claims.email !== undefined) idPayload.email = entry.claims.email;
      if (entry.claims.email_verified !== undefined) idPayload.email_verified = entry.claims.email_verified;
      if (entry.claims.groups && !entry.claims.groupsOnlyInUserInfo) {
        idPayload.groups = entry.claims.groups;
      }
      const accessToken = crypto.randomBytes(16).toString('base64url');
      accessTokens.set(accessToken, entry.claims);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: signJwt(idPayload),
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      const claims = accessTokens.get(token);
      if (!claims) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sub: claims.sub,
        ...(claims.email !== undefined ? { email: claims.email } : {}),
        ...(claims.email_verified !== undefined ? { email_verified: claims.email_verified } : {}),
        ...(claims.groups ? { groups: claims.groups } : {}),
      }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>(resolve => idpServer.listen(0, '127.0.0.1', resolve));
  const port = (idpServer.address() as AddressInfo).port;
  idpIssuer = `http://127.0.0.1:${port}`;
}

async function runBrowserOidcFlow(startPath = '/api/auth/oidc/login'): Promise<{ location: string; status: number }> {
  const loginRes = await fetch(`${appOrigin}${startPath}`, { redirect: 'manual' });
  expect(loginRes.status).toBe(302);
  const authUrl = loginRes.headers.get('location')!;
  const setCookie = loginRes.headers.get('set-cookie')!;
  const cookiePair = setCookie.split(';')[0];

  const idpRes = await fetch(authUrl, { redirect: 'manual' });
  expect(idpRes.status).toBe(302);
  const callbackUrl = idpRes.headers.get('location')!;

  const cbRes = await fetch(callbackUrl, {
    redirect: 'manual',
    headers: { Cookie: cookiePair },
  });
  return { status: cbRes.status, location: cbRes.headers.get('location') ?? '' };
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  await startMockIdp();
  const app = createApp();
  appServer = http.createServer(app);
  await new Promise<void>(resolve => appServer.listen(0, '127.0.0.1', resolve));
  appOrigin = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => appServer.close(() => resolve()));
  await new Promise<void>(resolve => idpServer.close(() => resolve()));
});

beforeEach(() => {
  clearOidcEnv();
  resetOidcState();
  issuedCodes.clear();
  accessTokens.clear();
  nextClaims = { sub: 'sub-admin-1', email: 'admin@example.com', email_verified: true };
  const db = getDb();
  db.prepare('DELETE FROM user_oidc_identities').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM api_keys').run();
});

afterEach(() => {
  clearOidcEnv();
  resetOidcState();
});

describe('OIDC dashboard authentication (#2008)', () => {
  it('stays completely off by default when unconfigured', async () => {
    const statusRes = await fetch(`${appOrigin}/api/auth/status`);
    const status = await statusRes.json() as Record<string, unknown>;
    expect(statusRes.status).toBe(200);
    expect(status.oidc).toBeUndefined();

    const loginRes = await fetch(`${appOrigin}/api/auth/oidc/login`, { redirect: 'manual' });
    expect(loginRes.status).toBe(404);
  });

  it('fails closed on auto-provisioning when no allowlist and no allowAnyUser is set', async () => {
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_AUTO_PROVISION = 'true';

    const status = await (await fetch(`${appOrigin}/api/auth/status`)).json() as { oidc: { enabled: boolean; canAutoProvision: boolean } };
    expect(status.oidc.enabled).toBe(true);
    expect(status.oidc.canAutoProvision).toBe(false);

    const { status: cbStatus, location } = await runBrowserOidcFlow();
    expect(cbStatus).toBe(302);
    expect(location).toBe('/#oidc_error=no_account');
  });

  it('completes Authorization Code + PKCE login, provisions a passwordless user, and enforces single-use code exchange', async () => {
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_PROVIDER_NAME = 'Authentik';
    process.env.OIDC_ALLOWED_EMAILS = 'admin@example.com';

    const status = await (await fetch(`${appOrigin}/api/auth/status`)).json() as { oidc: { providerName: string; canAutoProvision: boolean } };
    expect(status.oidc.providerName).toBe('Authentik');
    expect(status.oidc.canAutoProvision).toBe(true);

    const { status: cbStatus, location } = await runBrowserOidcFlow();
    expect(cbStatus).toBe(302);
    expect(location).toMatch(/^\/#oidc_code=/);
    const code = new URL(`http://local${location}`).hash.replace(/^#oidc_code=/, '');

    const exchangeRes = await fetch(`${appOrigin}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);
    const { token, email } = await exchangeRes.json() as { token: string; email: string };
    expect(token).toBeTruthy();
    expect(email).toBe('admin@example.com');

    // Replaying the same one-time code must fail.
    const replayRes = await fetch(`${appOrigin}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(replayRes.status).toBe(401);

    // Authenticated status reports OIDC provenance and passwordless flag.
    const meRes = await fetch(`${appOrigin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const me = await meRes.json() as { email: string; authSource: string; hasLocalPassword: boolean };
    expect(me).toMatchObject({ email: 'admin@example.com', authSource: 'oidc', hasLocalPassword: false });

    // Passwordless account cannot use password change endpoints.
    const cpRes = await fetch(`${appOrigin}/api/auth/change-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'anything', newPassword: 'newpassword123' }),
    });
    expect(cpRes.status).toBe(403);
    expect((await cpRes.json() as { error: { type: string } }).error.type).toBe('oidc_account_no_password');
  });

  it('rejects unverified emails and non-allowlisted users, and supports UserInfo group allowlists', async () => {
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_ALLOWED_EMAILS = 'admin@example.com';

    nextClaims = { sub: 'sub-unverified', email: 'admin@example.com', email_verified: false };
    expect((await runBrowserOidcFlow()).location).toBe('/#oidc_error=unverified_email');

    nextClaims = { sub: 'sub-stranger', email: 'stranger@example.com', email_verified: true };
    expect((await runBrowserOidcFlow()).location).toBe('/#oidc_error=not_allowed');

    // Group allowlist pulled via UserInfo fallback.
    delete process.env.OIDC_ALLOWED_EMAILS;
    process.env.OIDC_ALLOWED_GROUPS = 'freellmapi-admins';
    nextClaims = {
      sub: 'sub-group-user',
      email: 'ops@example.com',
      email_verified: true,
      groups: ['developers', 'freellmapi-admins'],
      groupsOnlyInUserInfo: true,
    };
    expect((await runBrowserOidcFlow()).location).toMatch(/^\/#oidc_code=/);
  });

  it('rejects callback with missing or mismatched CSRF state cookie', async () => {
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_ALLOWED_EMAILS = 'admin@example.com';

    const loginRes = await fetch(`${appOrigin}/api/auth/oidc/login`, { redirect: 'manual' });
    const idpRes = await fetch(loginRes.headers.get('location')!, { redirect: 'manual' });
    const callbackUrl = idpRes.headers.get('location')!;

    // Call callback WITHOUT the HttpOnly state cookie.
    const cbRes = await fetch(callbackUrl, { redirect: 'manual' });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('location')).toBe('/#oidc_error=invalid_state');
  });

  it('links to an existing local password account by verified email and respects OIDC_DISABLE_PASSWORD_LOGIN', async () => {
    createUser('admin@example.com', 'local-pass-123');
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_ALLOWED_EMAILS = 'admin@example.com';
    process.env.OIDC_DISABLE_PASSWORD_LOGIN = 'true';

    // Password login is blocked while OIDC_DISABLE_PASSWORD_LOGIN=true.
    const pwdRes = await fetch(`${appOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'local-pass-123' }),
    });
    expect(pwdRes.status).toBe(403);
    expect((await pwdRes.json() as { error: { type: string } }).error.type).toBe('password_login_disabled');

    // OIDC links to the existing user instead of creating a duplicate.
    const { location } = await runBrowserOidcFlow();
    const code = new URL(`http://local${location}`).hash.replace(/^#oidc_code=/, '');
    const ex = await (await fetch(`${appOrigin}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json() as { token: string };

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    expect(count).toBe(1);
    const me = await (await fetch(`${appOrigin}/api/auth/me`, {
      headers: { Authorization: `Bearer ${ex.token}` },
    })).json() as { authSource: string; hasLocalPassword: boolean };
    expect(me).toMatchObject({ authSource: 'oidc', hasLocalPassword: true });
  });

  it('gates plaintext key reveal and export behind OIDC step-up re-auth for passwordless users', async () => {
    process.env.OIDC_ISSUER_URL = idpIssuer;
    process.env.OIDC_CLIENT_ID = 'freellmapi-test';
    process.env.OIDC_ALLOWED_EMAILS = 'admin@example.com';

    const { encrypted, iv, authTag } = encrypt('sk-live-secret-value');
    const keyId = Number(getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES ('groq', 'primary', ?, ?, ?, 1, 'healthy')
    `).run(encrypted, iv, authTag).lastInsertRowid);

    const { location } = await runBrowserOidcFlow();
    const code = new URL(`http://local${location}`).hash.replace(/^#oidc_code=/, '');
    const { token } = await (await fetch(`${appOrigin}/api/auth/oidc/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json() as { token: string };

    // Before step-up re-auth: reveal and export return 403 oidc_reauth_required.
    const revealBefore = await fetch(`${appOrigin}/api/keys/${keyId}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revealBefore.status).toBe(403);
    expect((await revealBefore.json() as { error: { type: string } }).error.type).toBe('oidc_reauth_required');

    // Start OIDC step-up re-auth and complete callback.
    const startRes = await fetch(`${appOrigin}/api/auth/oidc/reauth/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnPath: '/keys' }),
    });
    expect(startRes.status).toBe(200);
    const { authorizeUrl } = await startRes.json() as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get('prompt')).toBe('login');
    expect(new URL(authorizeUrl).searchParams.get('max_age')).toBe('60');
    const cookiePair = startRes.headers.get('set-cookie')!.split(';')[0];

    const idpRes = await fetch(authorizeUrl, { redirect: 'manual' });
    const cbRes = await fetch(idpRes.headers.get('location')!, {
      redirect: 'manual',
      headers: { Cookie: cookiePair },
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('location')).toBe('/keys#oidc_reauth=ok');

    // Now reveal and export succeed without a password header.
    const revealAfter = await fetch(`${appOrigin}/api/keys/${keyId}/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revealAfter.status).toBe(200);
    expect((await revealAfter.json() as { key: string }).key).toBe('sk-live-secret-value');

    const exportAfter = await fetch(`${appOrigin}/api/keys/export?format=json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(exportAfter.status).toBe(200);
    expect(await exportAfter.text()).toContain('sk-live-secret-value');
  });

  it('supports configuring OIDC via declarative config (FREEAPI_CONFIG_JSON)', async () => {
    const applied = applyDeclarativeConfig({
      oidc: {
        issuerUrl: idpIssuer,
        clientId: 'freellmapi-test',
        providerName: 'Pocket ID',
        allowedEmails: ['admin@example.com'],
      },
    }, 'test-config');
    expect(applied.oidc).toBe(true);

    const status = await (await fetch(`${appOrigin}/api/auth/status`)).json() as { oidc: { providerName: string; enabled: boolean } };
    expect(status.oidc).toMatchObject({ enabled: true, providerName: 'Pocket ID' });
  });
});
