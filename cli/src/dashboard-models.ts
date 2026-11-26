import { readFileSync } from 'node:fs';
import { DashboardHttpError, dashboardClient, type DashboardOptions } from './dashboard.js';
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

export interface Row {
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
    '  freellmapi models add <file.json> [--dry-run]',
    '',
    `K is one of ${MODEL_KINDS.join(', ')} (default chat). IDs are the numeric IDs from models list.`,
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
    'Use FREELLMAPI_DASHBOARD_TOKEN or --token for the dashboard session token.',
    'Search kind lists search engines; decision kind lists decision models.',
    'add registers chat models from a JSON array of objects (chat kind only). Fields: platform, modelId',
    '(required); displayName, contextWindow, rpmLimit, rpdLimit, tpmLimit, tpdLimit, monthlyTokenBudget,',
    'supportsVision, supportsTools, keyId, endpointScope (optional). Every row is validated before any request.',
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

export async function fetchRows(request: <T>(path: string) => Promise<T>, kind: Kind): Promise<Row[]> {
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

const positive = (v: unknown): boolean => v === null || (Number.isSafeInteger(v) && (v as number) > 0);
const ADD_FIELDS: Record<string, (v: unknown) => boolean> = {
  platform: v => typeof v === 'string' && v.length >= 1 && v.length <= 50,
  modelId: v => typeof v === 'string' && v.length >= 1 && v.length <= 200,
  displayName: v => typeof v === 'string' && v.length >= 1 && v.length <= 200,
  contextWindow: positive,
  rpmLimit: positive,
  rpdLimit: positive,
  tpmLimit: positive,
  tpdLimit: positive,
  monthlyTokenBudget: v => typeof v === 'string' && v.length <= 80,
  supportsVision: v => typeof v === 'boolean',
  supportsTools: v => typeof v === 'boolean',
  keyId: positive,
  endpointScope: v => v === null || typeof v === 'string',
};

type NewModel = Record<string, unknown> & { platform: string; modelId: string };

/** Local mirror of createModelSchema (strict). Collects every problem so one run fixes the whole file. */
export function parseNewModels(text: string): NewModel[] {
  let rows: unknown;
  try { rows = JSON.parse(text); } catch { throw new Error('The models file is not valid JSON'); }
  if (!Array.isArray(rows) || !rows.length) throw new Error('The models file must be a non-empty JSON array of objects');
  const problems: string[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const label = `row ${i + 1}`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) { problems.push(`${label}: not an object`); return; }
    for (const [key, value] of Object.entries(row)) {
      const check = Object.hasOwn(ADD_FIELDS, key) ? ADD_FIELDS[key] : undefined;
      if (!check) problems.push(`${label}: unknown field "${oneLine(key, 40)}"`);
      else if (!check(value)) problems.push(`${label}: invalid ${key}`);
    }
    for (const key of ['platform', 'modelId']) {
      if (!(key in row)) problems.push(`${label}: missing ${key}`);
    }
    const r = row as NewModel;
    const id = JSON.stringify([r.platform, r.modelId, r.keyId ?? null]);
    if (seen.has(id)) problems.push(`${label}: duplicate of an earlier row`);
    seen.add(id);
  });
  if (problems.length) {
    const shown = problems.slice(0, 10);
    const more = problems.length > shown.length ? `\n  ...and ${problems.length - shown.length} more` : '';
    throw new Error(`Invalid models file:\n  ${shown.join('\n  ')}${more}`);
  }
  return rows as NewModel[];
}

async function addModels(options: ModelsCommandOptions, file: string | undefined): Promise<number> {
  if (!file) throw new Error(`models add needs a JSON file.\n\n${modelsHelp()}`);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`Could not read ${oneLine(file, 80)}`); }
  const models = parseNewModels(text);

  const { request } = dashboardClient(options);
  const has = (list: Row[], m: NewModel): boolean => list.some(r => r.platform === m.platform && r.modelId === m.modelId);
  const before = await fetchRows(request, 'chat');
  const results: Array<{ model: NewModel; result: string; detail: string }> = [];
  for (const model of models) {
    let result = 'would add';
    let detail = '';
    // Custom rows are keyed by endpoint scope too, so the server's 409 decides for them.
    if (model.platform !== 'custom' && has(before, model)) result = 'present';
    else if (!options.dryRun) {
      try {
        await request('/api/models', 'POST', model);
        result = 'added';
      } catch (error) {
        if (error instanceof DashboardHttpError && error.status === 409) result = 'present';
        else if (error instanceof DashboardHttpError) { result = 'failed'; detail = error.message; }
        else throw error;
      }
    }
    results.push({ model, result, detail });
  }
  if (results.some(r => r.result === 'added')) {
    const after = await fetchRows(request, 'chat');
    for (const r of results) {
      if (r.result === 'added' && !has(after, r.model)) { r.result = 'failed'; r.detail = 'not found on read-back'; }
    }
  }
  process.stdout.write(`${formatTable(['ROW', 'PLATFORM', 'MODEL', 'RESULT', 'DETAIL'],
    results.map((r, i) => [String(i + 1), oneLine(r.model.platform, 40), oneLine(r.model.modelId, 60), r.result, oneLine(r.detail, 60)]), [0])}\n`);
  const tally = (name: string): number => results.filter(r => r.result === name).length;
  const pending = options.dryRun ? `${tally('would add')} to add` : `${tally('added')} added`;
  process.stdout.write(`${options.dryRun ? 'Dry run, nothing sent. ' : ''}${pending}, ${tally('present')} already present, ${tally('failed')} failed.\n`);
  return tally('failed') ? 1 : 0;
}

export async function runModels(options: ModelsCommandOptions): Promise<number> {
  const [action, ...rest] = options.args;
  if (!action || !['list', 'enable', 'disable', 'add'].includes(action)) {
    throw new Error(`Expected models list, enable, disable, or add.\n\n${modelsHelp()}`);
  }
  if (options.dryRun && action !== 'add') throw new Error('--dry-run is only supported by models add; no request was made');
  const kind = (options.kind ?? 'chat') as Kind;
  if (action === 'add') {
    if (options.kind !== undefined || options.platform !== undefined || options.enabledFilter !== undefined || options.json) {
      throw new Error('models add registers chat models only and takes no --kind, --platform, --enabled, --disabled, or --json');
    }
    if (rest.length > 1) throw new Error(`models add takes one file.

${modelsHelp()}`);
    return addModels(options, rest[0]);
  }
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
