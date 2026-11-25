import { dashboardClient, type DashboardOptions } from './dashboard.js';
import { formatTable, oneLine } from './table.js';

export interface ModelsCommandOptions extends DashboardOptions {
  args: string[];
  dryRun: boolean;
  json: boolean;
  kind?: string;
  platform?: string;
  enabledFilter?: boolean;
}

export const MODEL_KINDS = ['chat', 'media', 'embedding', 'search', 'decision'] as const;
type Kind = typeof MODEL_KINDS[number];

interface Row {
  id: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  /** Embedding rows only: the PUT body needs the stored priority back. */
  priority?: number;
  family?: string;
}

export function modelsHelp(): string {
  return [
    'Model management (dashboard authentication):',
    '  freellmapi models list [--kind K] [--platform a,b] [--enabled | --disabled] [--json]',
    '  freellmapi models enable <id...> [--kind K]',
    '  freellmapi models disable <id...> [--kind K]',
    '',
    `K is one of ${MODEL_KINDS.join(', ')} (default chat). IDs are the numeric IDs from models list.`,
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
    'Search kind lists search engines; decision kind lists decision models.',
  ].join('\n');
}

function array<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`The gateway returned an invalid ${what} list`);
  return value as T[];
}

type Raw = Record<string, unknown>;

function normalise(kind: Kind, raw: Raw, family?: string): Row {
  const id = raw?.id;
  if (!Number.isSafeInteger(id) || (id as number) <= 0 || typeof raw.platform !== 'string') {
    throw new Error(`The gateway returned an invalid ${kind} model list`);
  }
  // Search engines carry `engineId` where the others carry `modelId`.
  const modelId = kind === 'search' ? raw.engineId : raw.modelId;
  return {
    id: id as number,
    platform: raw.platform,
    modelId: String(modelId ?? ''),
    displayName: String(raw.displayName ?? ''),
    enabled: raw.enabled === true,
    priority: typeof raw.priority === 'number' ? raw.priority : undefined,
    family,
  };
}

async function fetchRows(request: <T>(path: string) => Promise<T>, kind: Kind): Promise<Row[]> {
  switch (kind) {
    case 'chat':
      return array<Raw>(await request('/api/models'), 'model').map(r => normalise(kind, r));
    case 'media':
      return array<Raw>((await request<{ models?: unknown }>('/api/media'))?.models, 'media model').map(r => normalise(kind, r));
    case 'embedding': {
      const body = await request<{ families?: unknown }>('/api/embeddings');
      return array<{ family?: string; providers?: unknown }>(body?.families, 'embedding family')
        .flatMap(f => array<Raw>(f?.providers, 'embedding model').map(r => normalise(kind, r, f.family)));
    }
    case 'search':
      return array<Raw>(await request('/api/search/engines'), 'search engine').map(r => normalise(kind, r));
    case 'decision':
      return array<Raw>(await request('/api/decisions/models'), 'decision model').map(r => normalise(kind, r));
  }
}

export async function runModels(options: ModelsCommandOptions): Promise<number> {
  const [action, ...rest] = options.args;
  if (!action || !['list', 'enable', 'disable'].includes(action)) {
    throw new Error(`Expected models list, enable, or disable.\n\n${modelsHelp()}`);
  }
  if (options.dryRun) throw new Error('--dry-run is not supported by models; no request was made');
  const kind = (options.kind ?? 'chat') as Kind;
  if (!MODEL_KINDS.includes(kind)) throw new Error(`--kind must be one of ${MODEL_KINDS.join(', ')}`);

  let ids: number[] = [];
  if (action === 'list') {
    if (rest.length) throw new Error(`Invalid arguments for models list.\n\n${modelsHelp()}`);
  } else {
    if (options.platform !== undefined || options.enabledFilter !== undefined) {
      throw new Error('--platform, --enabled, and --disabled are only supported by models list');
    }
    if (options.json) throw new Error('--json is only supported by models list');
    if (!rest.length || rest.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
      throw new Error(`models ${action} needs one or more positive integer IDs.\n\n${modelsHelp()}`);
    }
    ids = [...new Set(rest.map(Number))];
  }
  const platforms = options.platform?.split(',').map(p => p.trim().toLowerCase());
  if (platforms && platforms.some(p => !/^[a-z][a-z0-9_-]*$/.test(p))) throw new Error('Invalid --platform list');

  const { request } = dashboardClient(options);
  const rows = await fetchRows(request, kind);

  if (action === 'list') {
    const shown = rows.filter(row => (!platforms || platforms.includes(row.platform))
      && (options.enabledFilter === undefined || row.enabled === options.enabledFilter));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(shown.map(r => ({
        kind, id: r.id, platform: r.platform, modelId: r.modelId, displayName: r.displayName, enabled: r.enabled,
      })), null, 2)}\n`);
    } else if (!shown.length) {
      process.stdout.write(`No ${kind} models match.\n`);
    } else {
      process.stdout.write(`${formatTable(['ID', 'PLATFORM', 'MODEL', 'ENABLED'],
        shown.map(r => [String(r.id), oneLine(r.platform, 40), oneLine(r.modelId, 60), r.enabled ? 'yes' : 'no']), [0])}\n`);
    }
    return 0;
  }

  const enabled = action === 'enable';
  const selected = ids.map(id => {
    const row = rows.find(r => r.id === id);
    if (!row) throw new Error(`Unknown ${kind} model ID ${id}. Run models list --kind ${kind}.`);
    return row;
  });

  if (kind === 'embedding') {
    // One PUT: the route has no per-row form and rewrites priority with enabled.
    await request('/api/embeddings', 'PUT', {
      providers: selected.map(r => ({ id: r.id, priority: r.priority ?? 0, enabled })),
    });
  } else {
    for (const row of selected) {
      if (kind === 'chat') {
        // Disabling also clears the routing flag server-side; enabling must restore it.
        await request(`/api/models/${row.id}`, 'PATCH', enabled ? { enabled, fallbackEnabled: true } : { enabled });
      } else if (kind === 'media') {
        await request(`/api/media/${row.id}`, 'PUT', { enabled });
      } else if (kind === 'search') {
        await request(`/api/search/engines/${row.id}`, 'PATCH', { enabled });
      } else {
        await request(`/api/decisions/models/${row.id}`, 'PATCH', { enabled });
      }
    }
  }
  for (const row of selected) {
    process.stdout.write(`${enabled ? 'Enabled' : 'Disabled'} ${kind} model ${row.id} (${oneLine(row.platform, 40)}/${oneLine(row.modelId, 60)}).\n`);
  }
  return 0;
}
