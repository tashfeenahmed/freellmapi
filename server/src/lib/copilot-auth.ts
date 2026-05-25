/**
 * GitHub Copilot — Path B (opencode-style) auth helper.
 *
 * Runs the GitHub OAuth device-code flow against opencode's registered
 * OAuth app, returning the long-lived `gho_...` access token. The token
 * is then used directly as `Authorization: Bearer ...` against
 * `api.githubcopilot.com` (no token-exchange step). See
 * vault/02-areas/ai-agents/freellmapi-copilot-integration-plan.md for the
 * tradeoff between this and the canonical VSCode-style Path A.
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
