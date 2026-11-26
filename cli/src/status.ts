import { dashboardClient, type DashboardOptions } from './dashboard.js';
import { formatTable } from './table.js';

export interface StatusOptions extends DashboardOptions {
  args: string[];
  dryRun: boolean;
  json: boolean;
  range?: string;
  top?: string;
  limit?: string;
  requestStatus?: string;
}

interface KeyRow { platform: string; enabled: boolean; status: string }
interface EnabledRow { enabled: boolean }

const KINDS = ['chat', 'media', 'embedding', 'search', 'decision'] as const;
type Kind = typeof KINDS[number];
type KindCount = { enabled: number; total: number };

export function statusHelp(): string {
  return [
    'Gateway status:',
    '  freellmapi status [--json]',
    '',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000), --json',
    'Reports reachability and version without authentication. With FREELLMAPI_DASHBOARD_TOKEN',
    'or --token it also lists keys per platform and enabled models per kind.',
    'Exits 1 when the gateway is unreachable or unavailable.',
  ].join('\n');
}

function array<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`The gateway returned an invalid ${what} list`);
  return value as T[];
}

function tally(rows: EnabledRow[]): KindCount {
  return { enabled: rows.filter(row => row.enabled).length, total: rows.length };
}

export async function runStatus(options: StatusOptions): Promise<number> {
  if (options.args.length) throw new Error(`Unknown option: ${options.args[0]}`);
  if (options.dryRun) throw new Error('--dry-run is not supported by status; no request was made');
  if (options.range || options.top || options.limit || options.requestStatus) {
    throw new Error('status does not take --range, --top, --limit, or --status');
  }
  const client = dashboardClient(options, false);
  const live = await client.probe('/livez');
  const body = (live?.body && typeof live.body === 'object' ? live.body : {}) as Record<string, unknown>;
  const reachable = live !== null;
  const ok = live?.status === 200;
  const version = typeof body.version === 'string' ? body.version : null;
  const report: {
    url: string;
    reachable: boolean;
    status: string;
    version: string | null;
    keys: Array<{ platform: string; total: number; enabled: number; healthy: number }> | null;
    models: Record<Kind, KindCount> | null;
  } = {
    url: client.root,
    reachable,
    status: !reachable ? 'unreachable' : ok ? 'ok' : 'unavailable',
    version,
    keys: null,
    models: null,
  };

  if (ok && options.token?.trim()) {
    const { request } = dashboardClient(options);
    const keys = array<KeyRow>(await request('/api/keys'), 'key');
    const platforms = new Map<string, { platform: string; total: number; enabled: number; healthy: number }>();
    for (const key of keys) {
      if (typeof key?.platform !== 'string') throw new Error('The gateway returned an invalid key list');
      const row = platforms.get(key.platform) ?? { platform: key.platform, total: 0, enabled: 0, healthy: 0 };
      row.total += 1;
      if (key.enabled) row.enabled += 1;
      if (key.status === 'healthy') row.healthy += 1;
      platforms.set(key.platform, row);
    }
    report.keys = [...platforms.values()].sort((a, b) => a.platform.localeCompare(b.platform));

    // Each kind has its own dashboard route; embeddings are nested by family.
    const media = await request<{ models?: unknown }>('/api/media');
    const embeddings = await request<{ families?: Array<{ providers?: unknown }> }>('/api/embeddings');
    report.models = {
      chat: tally(array(await request('/api/models'), 'model')),
      media: tally(array(media?.models, 'media model')),
      embedding: tally(array<{ providers?: unknown }>(embeddings?.families, 'embedding family')
        .flatMap(family => array<EnabledRow>(family?.providers, 'embedding model'))),
      search: tally(array(await request('/api/search/engines'), 'search engine')),
      decision: tally(array(await request('/api/decisions/models'), 'decision model')),
    };
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  const out = [`Gateway  ${report.url}`, `Status   ${report.status}${version ? `  (version ${version})` : ''}`];
  if (!reachable) out.push('Could not reach the gateway. Check that it is running, then --url or FREELLMAPI_URL.');
  if (body.stored_keys_decryptable === false) out.push('Warning  stored provider keys cannot be decrypted (check the encryption key)');
  if (ok && !report.keys) out.push('', 'Set FREELLMAPI_DASHBOARD_TOKEN or pass --token to see keys and models.');
  if (report.keys && report.models) {
    out.push('', report.keys.length
      ? formatTable(['PLATFORM', 'KEYS', 'ENABLED', 'HEALTHY'],
        report.keys.map(row => [row.platform, String(row.total), String(row.enabled), String(row.healthy)]), [1, 2, 3])
      : 'No provider keys configured.');
    out.push('', formatTable(['MODELS', 'ENABLED', 'TOTAL'],
      KINDS.map(kind => [kind, String(report.models![kind].enabled), String(report.models![kind].total)]), [1, 2]));
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return ok ? 0 : 1;
}
