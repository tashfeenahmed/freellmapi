import { DashboardHttpError, dashboardClient, type DashboardOptions } from './dashboard.js';

export interface SettingsCommandOptions extends DashboardOptions {
  args: string[];
  dryRun: boolean;
}

type Check = (value: unknown) => boolean;

interface Spec {
  /** Accepted PUT fields. Every field is optional unless listed in `required`. */
  fields: Record<string, Check>;
  required?: string[];
  /** The PUT body is the value itself (a map or config object), not a wrapper with named fields. */
  freeform?: Check;
  example: string;
}

const isBool: Check = v => typeof v === 'boolean';
const isObject: Check = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const unit: Check = v => typeof v === 'number' && v >= 0 && v <= 1;
const nullableUnit: Check = v => v === null || unit(v);
const nonNegInt: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
const oneOf = (...values: string[]): Check => v => typeof v === 'string' && values.includes(v);

// Only non-secret router settings that have both GET and PUT in
// server/src/routes/settings.ts. api-key, url-tokens and proxy are left out
// on purpose: their values are credentials or may embed them.
const SETTINGS: Record<string, Spec> = {
  'agent-compatibility': {
    fields: { ollamaEmulation: oneOf('off', 'open-loopback', 'key-required'), exposeClaudeDiscoveryAliases: isBool },
    example: '{"ollamaEmulation":"off"}',
  },
  'anthropic-map': { fields: {}, freeform: v => isObject(v) && Object.values(v as object).every(x => typeof x === 'string'), example: '{"opus":"auto"}' },
  compression: { fields: {}, freeform: isObject, example: '{"mode":"off"}' },
  'enable-mcp': { fields: { enabled: isBool }, required: ['enabled'], example: '{"enabled":true}' },
  fusion: { fields: {}, freeform: isObject, example: 'the saved config object itself (GET wraps it as {config,maxK})' },
  'gemini-map': { fields: {}, freeform: v => isObject(v) && Object.values(v as object).every(x => typeof x === 'string'), example: '{"pro":"auto"}' },
  guardrails: {
    fields: { requestMaxTokensBudget: nonNegInt, maxConsecutiveUpstreamFails: nonNegInt },
    example: '{"maxConsecutiveUpstreamFails":3}',
  },
  headroom: { fields: { rampStart: nullableUnit, floor: nullableUnit }, example: '{"rampStart":0.2,"floor":null}' },
  'min-context-window': {
    fields: { value: v => typeof v === 'string' && /^(off|32k|128k|512k|1m)$/i.test(v) },
    required: ['value'],
    example: '{"value":"128k"}',
  },
  'min-reliability-floor': { fields: { floor: nullableUnit }, required: ['floor'], example: '{"floor":0.8}' },
  'output-limit': {
    fields: { mode: v => v === 'off' || v === 'auto' || (Number.isSafeInteger(v) && (v as number) >= 1) },
    required: ['mode'],
    example: '{"mode":"auto"} or {"mode":8192}',
  },
  'provider-moment-attribution': { fields: { enabled: isBool }, required: ['enabled'], example: '{"enabled":true}' },
  'system-date': { fields: { mode: oneOf('off', 'web_search', 'always') }, required: ['mode'], example: '{"mode":"web_search"}' },
  'task-weight-share': { fields: { share: nullableUnit }, required: ['share'], example: '{"share":0.3}' },
  unify: { fields: { enabled: isBool, overrides: isObject }, example: '{"enabled":true}' },
  'update-check': { fields: { enabled: isBool }, required: ['enabled'], example: '{"enabled":false}' },
};

const NAMES = Object.keys(SETTINGS);

export function settingsHelp(): string {
  return [
    'Router settings (dashboard authentication):',
    '  freellmapi settings get [name]',
    '  freellmapi settings set <name> <json> [--dry-run]',
    '',
    'get without a name prints every setting as one JSON object.',
    'set sends <json> as the PUT body and prints the stored result; --dry-run validates and prints it without sending.',
    'Names and an example PUT body:',
    ...NAMES.map(name => `  ${name.padEnd(28)}${SETTINGS[name].example}`),
    '',
    'GET and PUT shapes differ for fusion, anthropic-map and gemini-map: PUT takes the config or map itself.',
    'api-key, url-tokens and proxy are not exposed here.',
    'Options: --url URL, --token TOKEN, --timeout MS (default 30000)',
  ].join('\n');
}

function spec(name: string | undefined): Spec {
  if (!name || !Object.hasOwn(SETTINGS, name)) {
    throw new Error(`Unknown setting${name ? ` "${name.slice(0, 40)}"` : ''}. Available: ${NAMES.join(', ')}`);
  }
  return SETTINGS[name];
}

/** Local mirror of each PUT schema, so a typo fails before any request. The server stays the authority. */
export function parseSettingBody(name: string, text: string): Record<string, unknown> {
  const rule = spec(name);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error(`The value for ${name} is not valid JSON`); }
  if (!isObject(body)) throw new Error(`${name} takes a JSON object, e.g. ${rule.example}`);
  const object = body as Record<string, unknown>;
  if (rule.freeform) {
    if (!rule.freeform(object)) throw new Error(`Invalid ${name} value. Example: ${rule.example}`);
    return object;
  }
  for (const [key, value] of Object.entries(object)) {
    const check = Object.hasOwn(rule.fields, key) ? rule.fields[key] : undefined;
    if (!check) throw new Error(`${name} has no field "${key.slice(0, 40)}". Fields: ${Object.keys(rule.fields).join(', ')}`);
    if (!check(value)) throw new Error(`Invalid ${name}.${key}. Example: ${rule.example}`);
  }
  for (const key of rule.required ?? []) {
    if (!(key in object)) throw new Error(`${name} needs "${key}". Example: ${rule.example}`);
  }
  if (!Object.keys(object).length) throw new Error(`${name} needs at least one field. Example: ${rule.example}`);
  return object;
}

export async function runSettings(options: SettingsCommandOptions): Promise<number> {
  const [action, name, ...rest] = options.args;
  if (action === 'get') {
    if (rest.length) throw new Error(`Invalid arguments for settings get.\n\n${settingsHelp()}`);
    if (name !== undefined) spec(name);
    if (options.dryRun) throw new Error('--dry-run is only supported by settings set; no request was made');
    const { request } = dashboardClient(options);
    const names = name === undefined ? NAMES : [name];
    const values: Record<string, unknown> = {};
    let failed = false;
    for (const each of names) {
      try {
        values[each] = await request(`/api/settings/${each}`);
      } catch (error) {
        // Auth and transport errors abort; a single route failing is reported in place.
        if (!(error instanceof DashboardHttpError)) throw error;
        values[each] = { error: error.message };
        failed = true;
      }
    }
    process.stdout.write(`${JSON.stringify(name === undefined ? values : values[name], null, 2)}\n`);
    return failed ? 1 : 0;
  }
  if (action === 'set') {
    if (rest.length !== 1) throw new Error(`settings set needs a name and one JSON value.\n\n${settingsHelp()}`);
    const body = parseSettingBody(name, rest[0]);
    if (options.dryRun) {
      process.stdout.write(`Would PUT /api/settings/${name}\n${JSON.stringify(body, null, 2)}\n`);
      return 0;
    }
    const { request } = dashboardClient(options);
    const stored = await request(`/api/settings/${name}`, 'PUT', body);
    process.stdout.write(`${JSON.stringify(stored, null, 2)}\n`);
    return 0;
  }
  throw new Error(`Expected settings get or set.\n\n${settingsHelp()}`);
}
