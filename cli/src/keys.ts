export interface KeyCommandOptions {
  url: string;
  args: string[];
  token?: string;
  key?: string;
  keyId?: number;
  timeoutMs?: number;
  dryRun: boolean;
}

interface KeyRow {
  id: number;
  platform: string;
  enabled: boolean;
  status: string;
  lastHealthError?: string | null;
  modelScope?: string[] | null;
  models?: Array<{ id: number; kind: string }>;
}

interface ModelRow {
  id: number;
  platform: string;
  modelId: string;
  enabled: boolean;
  keyId?: number | null;
}

export function keysHelp(): string {
  return [
    'Provider key management (dashboard authentication):',
    '  freellmapi keys add <platform> [--key KEY]',
    '  freellmapi keys list',
    '  freellmapi keys remove <platform> [--id ID]',
    '  freellmapi keys test <platform> [--id ID]',
    '',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
    'The unified --api-key / FREELLMAPI_API_KEY is not dashboard authentication.',
    'Omit --key for hidden terminal input. Keyless providers do not prompt.',
    'remove requires --id when a platform has multiple keys; test checks all matches.',
    'list shows enabled chat model counts, respecting each key\'s model scope.',
    'add saves the key, then checks it; failed validation leaves it saved and exits 1.',
  ].join('\n');
}

function gatewayRoot(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('--url must be an HTTP(S) gateway URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('--url must be an HTTP(S) URL without credentials, a query, or a fragment');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function modelCount(key: KeyRow, models: ModelRow[]): number {
  const customIds = new Set(key.models?.filter(m => m.kind === 'chat').map(m => m.id));
  return models.filter(model => model.enabled && model.platform === key.platform
    && (!key.modelScope?.length || key.modelScope.includes(model.modelId))
    && (key.platform === 'custom' ? customIds.has(model.id) : !model.keyId || model.keyId === key.id)).length;
}

const statuses = new Set(['healthy', 'invalid', 'unknown', 'rate_limited', 'error']);
function statusOf(status: string): string {
  return statuses.has(status) ? status : 'unknown';
}

export async function runKeys(
  options: KeyCommandOptions,
  prompt: () => Promise<string>,
): Promise<number> {
  const [action, rawPlatform, ...extra] = options.args;
  if (!action || !['add', 'list', 'remove', 'test'].includes(action)) {
    throw new Error(`Expected keys add, list, remove, or test.\n\n${keysHelp()}`);
  }
  if (extra.length || (action === 'list' ? rawPlatform !== undefined : !rawPlatform)) {
    throw new Error(`Invalid arguments for keys ${action}.\n\n${keysHelp()}`);
  }
  if (options.dryRun) throw new Error('--dry-run is not supported by keys; no request was made');
  if (options.key !== undefined && action !== 'add') throw new Error('--key is only supported by keys add');
  if (options.keyId !== undefined && action !== 'remove' && action !== 'test') {
    throw new Error('--id is only supported by keys remove and keys test');
  }
  const platform = rawPlatform?.toLowerCase();
  if (platform && !/^[a-z][a-z0-9_-]*$/.test(platform)) throw new Error('Invalid provider platform identifier');
  const token = options.token?.trim();
  if (!token) throw new Error('Set FREELLMAPI_DASHBOARD_TOKEN or pass --token with a dashboard session token');
  const root = gatewayRoot(options.url);
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new Error('--timeout must be a positive integer of at most 2147483647 milliseconds');
  }

  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      throw new Error('Could not complete the dashboard request. Check --url, connectivity, and --timeout.');
    }
    // Provider error bodies may contain credentials. Only report the HTTP
    // status, never echo arbitrary response bodies or transport errors.
    if (response.status === 401 || response.status === 403) {
      throw new Error('Dashboard authentication failed. Supply a current dashboard session token with --token or FREELLMAPI_DASHBOARD_TOKEN.');
    }
    if (!response.ok) throw new Error(`Dashboard request failed (HTTP ${response.status})`);
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; } catch { throw new Error('The gateway returned an invalid JSON response'); }
  }

  async function listKeys(): Promise<KeyRow[]> {
    const rows = await request<KeyRow[]>('/api/keys');
    if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id)
      || row.id <= 0 || typeof row.platform !== 'string')) {
      throw new Error('The gateway returned an invalid key list');
    }
    return rows;
  }

  async function check(id: number, provider: string): Promise<number> {
    const result = await request<{ keyId: number; status: string }>(`/api/health/check/${id}`, 'POST');
    if (!result || result.keyId !== id) throw new Error('The gateway returned an invalid health check result');
    // A transport failure preserves the previous status on the server, so
    // HTTP 200 / status=healthy alone cannot prove this check succeeded.
    const current = (await listKeys()).find(row => row.id === id);
    if (!current) throw new Error('The key no longer exists');
    const status = statusOf(result.status === 'healthy' ? current.status : result.status);
    const inconclusive = !!current.lastHealthError && status !== 'invalid';
    process.stdout.write(`${id}\t${provider}\t${inconclusive ? `inconclusive (stored status: ${statusOf(current.status)})` : status}\n`);
    return status === 'healthy' && !inconclusive ? 0 : 1;
  }

  if (action === 'add') {
    const { providers } = await request<{ providers: Array<{ platform: string; keyless?: boolean }> }>('/api/keys/providers');
    const provider = providers.find(p => p.platform === platform);
    if (!provider) {
      throw new Error(platform === 'custom'
        ? 'Custom endpoints require URL and model registration; add them in the dashboard.'
        : 'Unknown provider platform. Use the provider identifier shown in the dashboard.');
    }
    const value = (options.key ?? (provider.keyless ? '' : await prompt())).trim();
    if (!value && !provider.keyless) throw new Error('A provider API key is required');
    const saved = await request<{ id: number }>('/api/keys', 'POST', { platform, key: value });
    if (!Number.isSafeInteger(saved.id) || saved.id <= 0) throw new Error('The gateway did not return a valid saved key ID');
    process.stdout.write(`Saved ${platform} key ${saved.id}. Checking it now; the key remains saved if validation fails.\n`);
    return check(saved.id, platform!);
  }

  const rows = await listKeys();
  if (action === 'list') {
    if (!rows.length) {
      process.stdout.write('No provider keys configured.\n');
      return 0;
    }
    const models = await request<ModelRow[]>('/api/models');
    if (!Array.isArray(models)) throw new Error('The gateway returned an invalid model list');
    process.stdout.write('ID\tPLATFORM\tMODELS\tENABLED\tSTATUS\n');
    for (const row of rows) {
      const provider = /^[a-z][a-z0-9_-]*$/.test(row.platform) ? row.platform : 'unknown';
      process.stdout.write(`${row.id}\t${provider}\t${modelCount(row, models)}\t${row.enabled ? 'enabled' : 'disabled'}\t${statusOf(row.status)}\n`);
    }
    return 0;
  }

  const selected = rows.filter(row => row.platform === platform && (options.keyId === undefined || row.id === options.keyId));
  if (!selected.length) throw new Error('No matching key found for that platform and ID');
  if (action === 'remove') {
    if (selected.length > 1) throw new Error('Multiple keys match. Run keys list and specify one with --id.');
    await request(`/api/keys/${selected[0].id}`, 'DELETE');
    process.stdout.write(`Removed ${platform} key ${selected[0].id}.\n`);
    return 0;
  }

  let exitCode = 0;
  for (const row of selected) exitCode = Math.max(exitCode, await check(row.id, platform!));
  return exitCode;
}
