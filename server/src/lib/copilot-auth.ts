/**
 * GitHub Copilot — Path B (opencode-style) auth helper.
 *
 * Runs the GitHub OAuth device-code flow against opencode's registered
 * OAuth app, returning the long-lived `gho_...` access token. The token
 * is then used directly as `Authorization: Bearer ...` against
 * `api.githubcopilot.com` (no per-request token-exchange dance).
 *
 * `exchangeToken()` is a ONE-SHOT call we make at login only — Path-A
 * Step 3 — so we can pull the user's plan SKU and account-variant
 * endpoint base URL. The short-lived session token it returns is
 * thrown away; we use the long-lived gho_ token on inference calls.
 */

// opencode's registered OAuth client_id (Path B). Using this id makes
// traffic identifiable as opencode at GitHub's edge, not as real VSCode —
// the accepted fingerprint tradeoff for ~150 fewer lines of code.
export const OPENCODE_CLIENT_ID = 'Ov23li8tweQw6odWQebz';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Step 1: request a device code from GitHub. The returned `user_code` is
 * what the human types at `verification_uri`; `device_code` is what we
 * poll with.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'freellmapi-copilot/0.1.0',
    },
    body: JSON.stringify({
      client_id: OPENCODE_CLIENT_ID,
      scope: 'read:user',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`device_code request failed (${res.status}): ${text}`);
  }
  return await res.json() as DeviceCodeResponse;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'success'; accessToken: string }
  | { status: 'error'; message: string };

/**
 * Step 2 (single shot): make one access-token POST. Caller decides
 * cadence. Used by the dashboard device-flow endpoint, where the
 * browser drives polling and we don't want to block the request
 * thread with sleeps.
 */
export async function attemptTokenExchange(deviceCode: string): Promise<PollResult> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'freellmapi-copilot/0.1.0',
    },
    body: JSON.stringify({
      client_id: OPENCODE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json() as AccessTokenResponse;
  if (data.access_token) return { status: 'success', accessToken: data.access_token };
  switch (data.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow_down' };
    case 'expired_token':
      return { status: 'error', message: 'Device code expired before authorization. Restart the login.' };
    case 'access_denied':
      return { status: 'error', message: 'Authorization was denied in the browser.' };
    default:
      return { status: 'error', message: `OAuth error: ${data.error ?? 'unknown'} — ${data.error_description ?? ''}` };
  }
}

/**
 * Step 2 (loop): poll for the access token until it resolves. Used by
 * the CLI script — the browser-driven flow uses `attemptTokenExchange`
 * one call at a time instead.
 */
export async function pollForAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  options: { onPending?: () => void; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000; // 15 min cap
  const deadline = Date.now() + timeoutMs;
  let interval = (intervalSeconds + 1) * 1000; // small safety margin

  while (Date.now() < deadline) {
    await sleep(interval);

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'freellmapi-copilot/0.1.0',
      },
      body: JSON.stringify({
        client_id: OPENCODE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await res.json() as AccessTokenResponse;

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case 'authorization_pending':
        options.onPending?.();
        continue;
      case 'slow_down':
        interval += 5000;
        continue;
      case 'expired_token':
        throw new Error('Device code expired before authorization. Re-run the login.');
      case 'access_denied':
        throw new Error('Authorization was denied in the browser.');
      default:
        throw new Error(`Unexpected OAuth error: ${data.error ?? 'unknown'} — ${data.error_description ?? ''}`);
    }
  }
  throw new Error(`Device-flow timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

/**
 * Convenience wrapper: run the full device flow end-to-end. The caller
 * supplies `onCode` which is invoked once with the verification URL and
 * user code so the CLI can print them to stdout.
 */
export async function runDeviceFlow(
  onCode: (info: { userCode: string; verificationUri: string; expiresIn: number }) => void,
): Promise<string> {
  const dc = await requestDeviceCode();
  onCode({
    userCode: dc.user_code,
    verificationUri: dc.verification_uri,
    expiresIn: dc.expires_in,
  });
  return await pollForAccessToken(dc.device_code, dc.interval);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ────────────────────────────────────────────────────────────────────────
// Path-A Step 3 — one-shot exchange at login.
// ────────────────────────────────────────────────────────────────────────

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

export interface ExchangeResult {
  /** The user's plan tier marker, parsed from the `sku=` field of the
   *  short-lived session token (e.g. "copilot_individual",
   *  "copilot_individual_pro_plus", "free", "copilot_student",
   *  "copilot_business", "copilot_enterprise"). */
  sku: string;
  /** The full raw `token` field from the response — semicolon-delimited
   *  key=value pairs. Kept so callers can inspect other fields like
   *  `chat_enabled_for_student` without re-doing the exchange. */
  rawToken: string;
  /** Account-variant base URL for inference calls. Individual / Student
   *  Pack accounts get https://api.githubcopilot.com; business and
   *  enterprise accounts get the business/enterprise hostnames. */
  endpointBase: string;
  /** Wall-clock seconds when the exchange happened, for telemetry. */
  exchangedAt: number;
}

interface ExchangeApiResponse {
  token?: string;
  expires_at?: number;
  refresh_in?: number;
  endpoints?: { api?: string };
}

/**
 * Path-A Step 3. Trade the long-lived gho_ OAuth token for a session
 * token whose `sku=` field tells us the user's plan tier and whose
 * `endpoints.api` tells us the right inference base URL for this
 * account variant.
 *
 * Used at login ONLY. We do NOT call this per inference request — the
 * gho_ token works directly as Bearer for the inference endpoint, and
 * the sku rarely changes (a user upgrading their plan would need to
 * re-login to refresh tier; that's a v3 followup).
 *
 * The 3 critical headers below (Editor-Version, Editor-Plugin-Version,
 * User-Agent) are mandatory — GitHub returns 401 or a sku-stripped
 * response if any are missing.
 */
export async function exchangeToken(githubToken: string): Promise<ExchangeResult> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      'Authorization': `token ${githubToken}`,
      'Accept': 'application/json',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`copilot_internal/v2/token failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json() as ExchangeApiResponse;
  if (!data.token) {
    throw new Error('copilot_internal/v2/token response missing `token` field');
  }
  const sku = extractTokenField(data.token, 'sku') ?? '';
  const endpointBase = (data.endpoints?.api ?? 'https://api.githubcopilot.com').replace(/\/+$/, '');
  return {
    sku,
    rawToken: data.token,
    endpointBase,
    exchangedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Extract `name=value` from a Copilot session-token field. The field
 * looks like `tid=abc;exp=1748880000;sku=copilot_individual;...`.
 * Order isn't guaranteed; the parser is forgiving of stray whitespace.
 */
function extractTokenField(raw: string, name: string): string | undefined {
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}
