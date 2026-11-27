import crypto from 'node:crypto';
import * as client from 'openid-client';
import { getDb } from '../db/index.js';
import {
  createPasswordlessUser,
  createSession,
  normalizeEmail,
  stampSessionReauthenticated,
} from './auth.js';
import { clearSetupCode } from '../lib/setup-code.js';

// Opt-in OpenID Connect (OIDC) dashboard authentication (#2008).
//
// Active only when both issuerUrl and clientId are configured (via env vars or
// FREEAPI_CONFIG_JSON). Local and desktop installs with no OIDC config behave
// identically to before.

export interface DeclarativeOidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string;
  providerName?: string;
  allowedEmails?: string[];
  allowedGroups?: string[];
  groupsClaim?: string;
  autoProvision?: boolean;
  allowAnyUser?: boolean;
  disablePasswordLogin?: boolean;
  autoRedirect?: boolean;
  requireVerifiedEmail?: boolean;
  postLogoutRedirectUri?: string;
}

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string | null;
  scopes: string;
  providerName: string;
  allowedEmails: string[];
  allowedGroups: string[];
  groupsClaim: string;
  autoProvision: boolean;
  allowAnyUser: boolean;
  disablePasswordLogin: boolean;
  autoRedirect: boolean;
  requireVerifiedEmail: boolean;
  postLogoutRedirectUri: string | null;
}

export interface PublicOidcStatus {
  enabled: true;
  providerName: string;
  passwordLoginDisabled: boolean;
  autoRedirect: boolean;
  canAutoProvision: boolean;
}

export type OidcErrorCode =
  | 'not_configured'
  | 'invalid_state'
  | 'exchange_failed'
  | 'unverified_email'
  | 'not_allowed'
  | 'no_account'
  | 'identity_mismatch'
  | 'provider_error';

export class OidcFlowError extends Error {
  readonly code: OidcErrorCode;
  constructor(code: OidcErrorCode, message: string) {
    super(message);
    this.name = 'OidcFlowError';
    this.code = code;
  }
}

export const OIDC_TX_COOKIE_NAME = 'freellmapi_oidc_tx';
const DISCOVERY_TTL_MS = 15 * 60_000;
const TX_TTL_MS = 5 * 60_000;
const EXCHANGE_TTL_MS = 30_000;
const MAX_PENDING_ENTRIES = 200;
const REAUTH_MAX_AGE_SEC = 60;

interface PendingOidcTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  cookieSecret: string;
  purpose: 'login' | 'reauth';
  sessionTokenHash?: string;
  expectedUserId?: number;
  returnPath: string;
  expiresAtMs: number;
}

interface ExchangeGrant {
  token: string;
  email: string;
  expiresAtMs: number;
}

let declarativeOidc: DeclarativeOidcConfig | null = null;
let cachedDiscovery: { key: string; config: client.Configuration; expiresAtMs: number } | null = null;
let warnedOpenProvision = false;
const pendingTx = new Map<string, PendingOidcTx>();
const exchangeGrants = new Map<string, ExchangeGrant>();

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return undefined;
}

function parseListEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function isLoopbackIssuer(issuerUrl: string): boolean {
  try {
    const u = new URL(issuerUrl);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

export function setDeclarativeOidcConfig(config: DeclarativeOidcConfig | null): void {
  declarativeOidc = config;
  cachedDiscovery = null;
  warnedOpenProvision = false;
}

export function getOidcConfig(): OidcConfig | null {
  const issuerUrl = process.env.OIDC_ISSUER_URL?.trim() || declarativeOidc?.issuerUrl?.trim() || '';
  const clientId = process.env.OIDC_CLIENT_ID?.trim() || declarativeOidc?.clientId?.trim() || '';
  if (!issuerUrl || !clientId) return null;

  try {
    const parsed = new URL(issuerUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim()
    || declarativeOidc?.clientSecret?.trim()
    || null;
  const redirectUri = process.env.OIDC_REDIRECT_URI?.trim()
    || declarativeOidc?.redirectUri?.trim()
    || null;
  const scopes = process.env.OIDC_SCOPES?.trim()
    || declarativeOidc?.scopes?.trim()
    || 'openid email profile';
  const providerName = process.env.OIDC_PROVIDER_NAME?.trim()
    || declarativeOidc?.providerName?.trim()
    || 'SSO';
  const allowedEmails = (parseListEnv(process.env.OIDC_ALLOWED_EMAILS) ?? declarativeOidc?.allowedEmails ?? [])
    .map(normalizeEmail)
    .filter(Boolean);
  const allowedGroups = (parseListEnv(process.env.OIDC_ALLOWED_GROUPS) ?? declarativeOidc?.allowedGroups ?? [])
    .map(g => g.trim())
    .filter(Boolean);
  const groupsClaim = process.env.OIDC_GROUPS_CLAIM?.trim()
    || declarativeOidc?.groupsClaim?.trim()
    || 'groups';
  const allowAnyUser = parseBoolEnv(process.env.OIDC_ALLOW_ANY_USER)
    ?? declarativeOidc?.allowAnyUser
    ?? false;
  const hasAllowlist = allowedEmails.length > 0 || allowedGroups.length > 0;
  const requestedAutoProvision = parseBoolEnv(process.env.OIDC_AUTO_PROVISION)
    ?? declarativeOidc?.autoProvision;

  // Fail closed: every FreeLLMAPI dashboard user has full admin access to all
  // provider keys. Refuse open-world JIT admin provisioning unless the operator
  // set an allowlist OR explicitly acknowledged IdP-side gating with allowAnyUser.
  let autoProvision: boolean;
  if (requestedAutoProvision === false) {
    autoProvision = false;
  } else if (hasAllowlist || allowAnyUser) {
    autoProvision = true;
  } else {
    if (requestedAutoProvision === true && !warnedOpenProvision) {
      warnedOpenProvision = true;
      console.warn(
        '[OIDC] Refusing OIDC_AUTO_PROVISION without OIDC_ALLOWED_EMAILS or OIDC_ALLOWED_GROUPS. ' +
        'Configure an allowlist or explicitly set OIDC_ALLOW_ANY_USER=true if access is restricted at your IdP.',
      );
    }
    autoProvision = false;
  }

  const disablePasswordLogin = parseBoolEnv(process.env.OIDC_DISABLE_PASSWORD_LOGIN)
    ?? declarativeOidc?.disablePasswordLogin
    ?? false;
  const autoRedirect = parseBoolEnv(process.env.OIDC_AUTO_REDIRECT)
    ?? declarativeOidc?.autoRedirect
    ?? false;
  const requireVerifiedEmail = parseBoolEnv(process.env.OIDC_REQUIRE_VERIFIED_EMAIL)
    ?? declarativeOidc?.requireVerifiedEmail
    ?? true;
  const postLogoutRedirectUri = process.env.OIDC_POST_LOGOUT_REDIRECT_URI?.trim()
    || declarativeOidc?.postLogoutRedirectUri?.trim()
    || null;

  return {
    issuerUrl,
    clientId,
    clientSecret,
    redirectUri,
    scopes,
    providerName,
    allowedEmails,
    allowedGroups,
    groupsClaim,
    autoProvision,
    allowAnyUser,
    disablePasswordLogin,
    autoRedirect,
    requireVerifiedEmail,
    postLogoutRedirectUri,
  };
}

export function getPublicOidcStatus(): PublicOidcStatus | null {
  const cfg = getOidcConfig();
  if (!cfg) return null;
  return {
    enabled: true,
    providerName: cfg.providerName,
    passwordLoginDisabled: cfg.disablePasswordLogin,
    autoRedirect: cfg.autoRedirect,
    canAutoProvision: cfg.autoProvision,
  };
}

export function isPasswordLoginDisabled(): boolean {
  const cfg = getOidcConfig();
  return !!cfg?.disablePasswordLogin;
}

async function discoverClientConfig(cfg: OidcConfig, now = Date.now()): Promise<client.Configuration> {
  const cacheKey = `${cfg.issuerUrl}|${cfg.clientId}|${cfg.clientSecret ?? ''}`;
  if (cachedDiscovery && cachedDiscovery.key === cacheKey && cachedDiscovery.expiresAtMs > now) {
    return cachedDiscovery.config;
  }
  const allowHttp = isLoopbackIssuer(cfg.issuerUrl) || parseBoolEnv(process.env.OIDC_ALLOW_INSECURE_HTTP) === true;
  const options = allowHttp ? { execute: [client.allowInsecureRequests] } : undefined;
  const discovered = await client.discovery(
    new URL(cfg.issuerUrl),
    cfg.clientId,
    cfg.clientSecret ?? undefined,
    cfg.clientSecret ? undefined : client.None(),
    options,
  );
  cachedDiscovery = {
    key: cacheKey,
    config: discovered,
    expiresAtMs: now + DISCOVERY_TTL_MS,
  };
  return discovered;
}

function pruneMap<T extends { expiresAtMs: number }>(map: Map<string, T>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAtMs <= now) map.delete(key);
  }
  while (map.size >= MAX_PENDING_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function safeReturnPath(raw: string | undefined): string {
  if (!raw) return '/';
  // Strictly allow local relative paths (never protocol-relative //evil.com).
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw.split('#')[0] || '/';
}

export function sanitizeRedirectUri(cfg: OidcConfig, derivedOrigin: string): string {
  if (cfg.redirectUri) return cfg.redirectUri;
  const cleanOrigin = derivedOrigin.replace(/\/+$/, '');
  return `${cleanOrigin}/api/auth/oidc/callback`;
}

export async function startOidcAuthorization(params: {
  derivedOrigin: string;
  purpose: 'login' | 'reauth';
  sessionTokenHash?: string;
  expectedUserId?: number;
  returnPath?: string;
}): Promise<{ authorizeUrl: string; cookieValue: string }> {
  const cfg = getOidcConfig();
  if (!cfg) throw new OidcFlowError('not_configured', 'OIDC is not configured.');

  const discovered = await discoverClientConfig(cfg);
  const now = Date.now();
  pruneMap(pendingTx, now);

  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const cookieSecret = crypto.randomBytes(24).toString('base64url');
  const redirectUri = sanitizeRedirectUri(cfg, params.derivedOrigin);

  pendingTx.set(state, {
    state,
    nonce,
    codeVerifier,
    redirectUri,
    cookieSecret,
    purpose: params.purpose,
    sessionTokenHash: params.sessionTokenHash,
    expectedUserId: params.expectedUserId,
    returnPath: safeReturnPath(params.returnPath ?? (params.purpose === 'reauth' ? '/keys' : '/')),
    expiresAtMs: now + TX_TTL_MS,
  });

  const authParams: Record<string, string> = {
    redirect_uri: redirectUri,
    scope: cfg.scopes,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  if (params.purpose === 'reauth') {
    authParams.prompt = 'login';
    authParams.max_age = String(REAUTH_MAX_AGE_SEC);
  }

  const url = client.buildAuthorizationUrl(discovered, authParams);
  return { authorizeUrl: url.href, cookieValue: cookieSecret };
}

function timingSafeMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractGroups(claims: Record<string, unknown>, claimName: string): string[] {
  const raw = claims[claimName];
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map(g => g.trim());
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[,\s]+/).map(g => g.trim()).filter(Boolean);
  }
  return [];
}

function isEmailVerified(claims: Record<string, unknown>): boolean {
  return claims.email_verified === true || claims.email_verified === 'true';
}

function resolveUserForOidcLogin(
  cfg: OidcConfig,
  issuer: string,
  subject: string,
  email: string | null,
  emailVerified: boolean,
  groups: string[],
): { userId: number; email: string } {
  const db = getDb();

  // 1. Enforce allowlist before linking or provisioning.
  const hasAllowlist = cfg.allowedEmails.length > 0 || cfg.allowedGroups.length > 0;
  if (hasAllowlist) {
    const emailAllowed = !!email
      && (!cfg.requireVerifiedEmail || emailVerified)
      && cfg.allowedEmails.includes(email);
    const groupAllowed = cfg.allowedGroups.length > 0
      && groups.some(g => cfg.allowedGroups.includes(g));
    if (!emailAllowed && !groupAllowed) {
      if (email && cfg.allowedEmails.includes(email) && cfg.requireVerifiedEmail && !emailVerified) {
        throw new OidcFlowError('unverified_email', 'Your identity provider did not assert email_verified=true.');
      }
      throw new OidcFlowError('not_allowed', 'Your account is not in the allowed OIDC users or groups.');
    }
  }

  // 2. Existing (issuer, sub) binding always wins.
  const linked = db.prepare(`
    SELECT i.user_id, u.email
      FROM user_oidc_identities i
      JOIN users u ON u.id = i.user_id
     WHERE i.issuer = ? AND i.subject = ?
  `).get(issuer, subject) as { user_id: number; email: string } | undefined;
  if (linked) {
    if (email) {
      db.prepare('UPDATE user_oidc_identities SET email = ? WHERE issuer = ? AND subject = ?')
        .run(email, issuer, subject);
    }
    return { userId: linked.user_id, email: linked.email };
  }

  // 3. Link to an existing local account by verified email.
  if (email) {
    const existingUser = db.prepare('SELECT id, email FROM users WHERE email = ?')
      .get(email) as { id: number; email: string } | undefined;
    if (existingUser) {
      if (cfg.requireVerifiedEmail && !emailVerified) {
        throw new OidcFlowError('unverified_email', 'Email must be verified by the identity provider to link an existing account.');
      }
      db.prepare(`
        INSERT OR IGNORE INTO user_oidc_identities (user_id, issuer, subject, email)
        VALUES (?, ?, ?, ?)
      `).run(existingUser.id, issuer, subject, email);
      return { userId: existingUser.id, email: existingUser.email };
    }
  }

  // 4. Provision a new passwordless account when allowed.
  if (!cfg.autoProvision) {
    throw new OidcFlowError('no_account', 'No matching FreeLLMAPI account exists and OIDC auto-provisioning is disabled.');
  }
  if (email && cfg.requireVerifiedEmail && !emailVerified) {
    throw new OidcFlowError('unverified_email', 'Email must be verified by the identity provider to provision an account.');
  }

  const accountEmail = email || `${crypto.createHash('sha256').update(`${issuer}:${subject}`).digest('hex').slice(0, 16)}@oidc.local`;
  const created = createPasswordlessUser(accountEmail);
  db.prepare(`
    INSERT INTO user_oidc_identities (user_id, issuer, subject, email)
    VALUES (?, ?, ?, ?)
  `).run(created.userId, issuer, subject, email);
  clearSetupCode();
  return { userId: created.userId, email: created.email };
}

export type OidcCallbackResult =
  | { purpose: 'login'; exchangeCode: string; returnPath: string }
  | { purpose: 'reauth'; returnPath: string };

export async function completeOidcCallback(params: {
  callbackUrl: URL;
  stateParam: string | undefined;
  cookieValue: string | undefined;
}): Promise<OidcCallbackResult> {
  const cfg = getOidcConfig();
  if (!cfg) throw new OidcFlowError('not_configured', 'OIDC is not configured.');

  const now = Date.now();
  pruneMap(pendingTx, now);

  if (!params.stateParam) {
    throw new OidcFlowError('invalid_state', 'Missing OIDC state parameter.');
  }
  const tx = pendingTx.get(params.stateParam);
  pendingTx.delete(params.stateParam);
  if (!tx || tx.expiresAtMs <= now || !timingSafeMatch(params.cookieValue, tx.cookieSecret)) {
    throw new OidcFlowError('invalid_state', 'Invalid or expired OIDC login state.');
  }

  const discovered = await discoverClientConfig(cfg, now);

  // Align callback URL origin/path with the registered redirectUri so proxies
  // that rewrite internal host/scheme never break openid-client's URL check.
  const effectiveCallbackUrl = new URL(tx.redirectUri);
  effectiveCallbackUrl.search = params.callbackUrl.search;

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(discovered, effectiveCallbackUrl, {
      pkceCodeVerifier: tx.codeVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
      ...(tx.purpose === 'reauth' ? { maxAge: REAUTH_MAX_AGE_SEC } : {}),
    });
  } catch (err) {
    throw new OidcFlowError(
      'exchange_failed',
      `OIDC code exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const idClaims = tokens.claims();
  if (!idClaims || typeof idClaims.sub !== 'string' || !idClaims.sub) {
    throw new OidcFlowError('exchange_failed', 'OIDC ID token is missing a subject claim.');
  }

  const issuer = typeof idClaims.iss === 'string' && idClaims.iss
    ? idClaims.iss
    : discovered.serverMetadata().issuer;
  const subject = idClaims.sub;

  let mergedClaims: Record<string, unknown> = { ...idClaims };
  const needsUserInfo = (mergedClaims.email === undefined
    || (cfg.allowedGroups.length > 0 && mergedClaims[cfg.groupsClaim] === undefined))
    && typeof tokens.access_token === 'string'
    && Boolean(discovered.serverMetadata().userinfo_endpoint);
  if (needsUserInfo) {
    try {
      const userInfo = await client.fetchUserInfo(discovered, tokens.access_token, subject);
      // ID token iss & sub stay authoritative.
      mergedClaims = { ...userInfo, ...mergedClaims, iss: issuer, sub: subject };
    } catch (err) {
      console.warn(`[OIDC] UserInfo fetch failed (continuing with ID token claims): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (tx.purpose === 'reauth') {
    const linked = getDb().prepare(`
      SELECT user_id FROM user_oidc_identities WHERE issuer = ? AND subject = ?
    `).get(issuer, subject) as { user_id: number } | undefined;
    if (!linked || linked.user_id !== tx.expectedUserId || !tx.sessionTokenHash) {
      throw new OidcFlowError('identity_mismatch', 'OIDC re-authentication did not match the signed-in account.');
    }
    if (!stampSessionReauthenticated(tx.sessionTokenHash, Date.now())) {
      throw new OidcFlowError('invalid_state', 'Your dashboard session expired before re-verification completed.');
    }
    return { purpose: 'reauth', returnPath: tx.returnPath };
  }

  const rawEmail = typeof mergedClaims.email === 'string' && mergedClaims.email.trim()
    ? normalizeEmail(mergedClaims.email)
    : null;
  const emailVerified = isEmailVerified(mergedClaims);
  const groups = extractGroups(mergedClaims, cfg.groupsClaim);

  const user = resolveUserForOidcLogin(cfg, issuer, subject, rawEmail, emailVerified, groups);
  const sessionToken = createSession(user.userId, 'oidc');

  pruneMap(exchangeGrants, Date.now());
  const exchangeCode = crypto.randomBytes(24).toString('base64url');
  exchangeGrants.set(exchangeCode, {
    token: sessionToken,
    email: user.email,
    expiresAtMs: Date.now() + EXCHANGE_TTL_MS,
  });

  return { purpose: 'login', exchangeCode, returnPath: tx.returnPath };
}

export function consumeOidcExchangeCode(code: string | undefined): { token: string; email: string } | null {
  if (!code) return null;
  const now = Date.now();
  pruneMap(exchangeGrants, now);
  const grant = exchangeGrants.get(code);
  exchangeGrants.delete(code);
  if (!grant || grant.expiresAtMs <= now) return null;
  return { token: grant.token, email: grant.email };
}

export async function getOidcEndSessionUrl(): Promise<string | null> {
  const cfg = getOidcConfig();
  if (!cfg || !cfg.postLogoutRedirectUri) return null;
  try {
    const discovered = await discoverClientConfig(cfg);
    if (!discovered.serverMetadata().end_session_endpoint) return null;
    return client.buildEndSessionUrl(discovered, {
      client_id: cfg.clientId,
      post_logout_redirect_uri: cfg.postLogoutRedirectUri,
    }).href;
  } catch {
    return null;
  }
}

/** Test hook to clear in-memory caches and pending flows between test cases. */
export function resetOidcState(): void {
  declarativeOidc = null;
  cachedDiscovery = null;
  warnedOpenProvision = false;
  pendingTx.clear();
  exchangeGrants.clear();
}
